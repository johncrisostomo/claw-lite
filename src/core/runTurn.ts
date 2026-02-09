import { appendEvent, readEvents, type SessionEvent } from './sessionStore.js'
import { readFile as readFileFs } from 'node:fs/promises'
import * as path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

type OllamaMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'tool'; name: string; content: string; tool_call_id?: string }

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isPlainObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function resolveWorkspacePath(workspaceDir: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('args.path must be a non-empty string')
  if (path.isAbsolute(rel)) throw new Error('Absolute paths are not allowed')

  const resolved = path.resolve(workspaceDir, rel)
  const base = path.resolve(workspaceDir) + path.sep
  if (!resolved.startsWith(base)) throw new Error('Path escapes workspace')

  return resolved
}

type SearchResult = { title: string; link: string; snippet?: string }
type SearchEngine = 'duckduckgo' | 'google'

async function connectToBraveOrChromeOverCdp(cdpUrl: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(cdpUrl) // attach to existing visible browser [web:172]
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await context.newPage()
  return { browser, page }
}

async function launchHeadlessChromium(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  return { browser, page }
}

async function performBrowserSearch(opts: {
  query: string
  numResults: number
  timeoutMs: number
  engine: SearchEngine
  cdpUrl?: string
}): Promise<{ query: string; engine: SearchEngine; results: SearchResult[] }> {
  const { query, numResults, timeoutMs, engine } = opts
  const cdpUrl = opts.cdpUrl ?? 'http://localhost:9222'

  let browser: Browser | null = null
  let page: Page | null = null
  let usedCdp = false

  try {
    try {
      const cdp = await connectToBraveOrChromeOverCdp(cdpUrl)
      browser = cdp.browser
      page = cdp.page
      usedCdp = true
    } catch {
      const headless = await launchHeadlessChromium()
      browser = headless.browser
      page = headless.page
      usedCdp = false
    }

    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)

    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp}', (route) => route.abort())

    if (engine === 'duckduckgo') {
      await page.goto('https://duckduckgo.com/', { waitUntil: 'domcontentloaded' })

      const input = page.locator('input[name="q"]')
      await input.waitFor({ state: 'visible' })
      await input.fill(query)
      await input.press('Enter')

      await page.waitForSelector('a[data-testid="result-title-a"]', { state: 'attached' })

      const results = await page.evaluate((limit) => {
        const out: Array<{ title: string; link: string; snippet?: string }> = []

        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[data-testid="result-title-a"]')
        )

        for (const a of anchors) {
          const title = (a.textContent || '').trim()
          const link = (a.href || '').trim()
          if (!title || !link) continue

          const card = a.closest('[data-testid="result"]') as HTMLElement | null
          const snippetEl =
            card?.querySelector<HTMLElement>('[data-result="snippet"]') ??
            card?.querySelector<HTMLElement>('.result__snippet') ??
            null
          const snippet = snippetEl ? (snippetEl.textContent || '').trim() : undefined

          out.push({ title, link, snippet })
          if (out.length >= limit) break
        }

        return out
      }, numResults)

      return { query, engine, results }
    }

    // engine === 'google'
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' })

    const box = page.locator('textarea[name="q"]')
    await box.waitFor({ state: 'visible' })
    await box.fill(query)
    await box.press('Enter')

    // If Google blocks automation, it may redirect to /sorry/ [web:165]
    await page.waitForTimeout(1000)
    if (page.url().includes('/sorry/')) {
      throw new Error('Google blocked automated browsing (sorry page). Try engine=duckduckgo or use CDP with your real profile.')
    }

    await page.waitForSelector('#search', { state: 'visible' })

    const results = await page.evaluate((limit) => {
      const out: Array<{ title: string; link: string; snippet?: string }> = []
      const blocks = Array.from(document.querySelectorAll('div#search div.g'))

      for (const b of blocks) {
        const a = b.querySelector<HTMLAnchorElement>('a')
        const h3 = b.querySelector<HTMLHeadingElement>('h3')
        if (!a || !h3) continue

        const title = (h3.textContent || '').trim()
        const link = (a.href || '').trim()
        if (!title || !link) continue

        const snippetEl =
          b.querySelector<HTMLElement>('div[data-sncf="1"]') ||
          b.querySelector<HTMLElement>('span') ||
          null
        const snippet = snippetEl ? (snippetEl.textContent || '').trim() : undefined

        out.push({ title, link, snippet })
        if (out.length >= limit) break
      }

      return out
    }, numResults)

    return { query, engine, results }
  } finally {
    if (browser) {
      // If we connected over CDP, closing may close the underlying browser depending on how it was launched.
      // For “I want to watch it”, it’s usually better to NOT kill Brave.
      if (!usedCdp) await browser.close()
      else await browser.close()
    }
  }
}

const ALLOWED_TOOLS = new Set(['fs.readText', 'browserSearch'])

async function runTool(toolCall: { tool: string; args: unknown }, workspaceDir: string) {
  if (!ALLOWED_TOOLS.has(toolCall.tool)) {
    return { ok: false as const, error: `Tool not allowed: ${toolCall.tool}` }
  }

  if (toolCall.tool === 'fs.readText') {
    if (!isPlainObject(toolCall.args)) return { ok: false as const, error: 'args must be an object' }

    const relPath = (toolCall.args as any).path
    if (typeof relPath !== 'string') return { ok: false as const, error: 'args.path must be a string' }

    const fullPath = resolveWorkspacePath(workspaceDir, relPath)
    const text = await readFileFs(fullPath, 'utf8')
    return { ok: true as const, result: { path: relPath, text } }
  }

  if (toolCall.tool === 'browserSearch') {
    if (!isPlainObject(toolCall.args)) return { ok: false as const, error: 'args must be an object' }
    const args = toolCall.args as any

    const query = args.query
    if (typeof query !== 'string' || query.length === 0) {
      return { ok: false as const, error: 'args.query must be a non-empty string' }
    }

    const numResults = Math.min(Math.max(Number(args.numResults ?? 5), 1), 10)
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 30000), 1000), 60000)

    const engine: SearchEngine = args.engine === 'google' ? 'google' : 'duckduckgo'
    const cdpUrl = typeof args.cdpUrl === 'string' ? args.cdpUrl : 'http://localhost:9222'

    try {
      const result = await performBrowserSearch({ query, numResults, timeoutMs, engine, cdpUrl })
      return { ok: true as const, result }
    } catch (err: any) {
      return { ok: false as const, error: `Search failed: ${err?.message ?? String(err)}` }
    }
  }

  return { ok: false as const, error: `Tool not implemented: ${toolCall.tool}` }
}

async function loadWorkspaceMessages(agentId: string): Promise<OllamaMessage[]> {
  const workspaceDir = path.join(process.cwd(), 'workspaces', agentId)
  const [soul, tools] = await Promise.all([
    readFileFs(path.join(workspaceDir, 'SOUL.md'), 'utf8'),
    readFileFs(path.join(workspaceDir, 'TOOLS.md'), 'utf8'),
  ])

  return [
    { role: 'system', content: soul },
    { role: 'system', content: tools },
  ]
}

type OllamaToolCall = {
  id?: string
  function?: {
    name?: string
    arguments?: any
  }
}

async function callOllama(host: string, model: string, messages: OllamaMessage[]) {
  const resp = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Ollama error ${resp.status}: ${text}`)
  }

  const data = (await resp.json()) as any

  if (data?.error) {
    throw new Error(`Ollama returned error: ${data.error}`)
  }

  const msg = data?.message ?? {}
  const content = typeof msg.content === 'string' ? msg.content : ''
  const toolCalls: OllamaToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : []

  return { raw: data, message: msg, content, toolCalls }
}

function sanitizeToolName(name: any): string {
  if (typeof name !== 'string') return ''
  // Keep only a conservative set of characters, drop special tokens/prefixes.
  // Also strip common junk prefixes like "assistant<|channel|>".
  const stripped = name.replace(/assistant<\|channel\|>/g, '').trim()
  return stripped.replace(/[^a-zA-Z0-9._-]/g, '')
}

function normalizeToolCall(tc: OllamaToolCall): { id: string; tool: string; args: any } {
  const id = typeof tc?.id === 'string' && tc.id.length ? tc.id : uid()
  const fnArgs = tc?.function?.arguments

  if (isPlainObject(fnArgs) && typeof (fnArgs as any).tool === 'string') {
    const tool = sanitizeToolName((fnArgs as any).tool)
    return { id, tool, args: (fnArgs as any).args }
  }

  const fnName = tc?.function?.name
  const tool = sanitizeToolName(fnName)
  if (tool) return { id, tool, args: fnArgs }

  return { id, tool: 'unknown', args: fnArgs }
}

export async function runTurn(opts: {
  sessionId: string
  userText: string
  agentId?: string
  model?: string
  ollamaHost?: string
}) {
  const agentId = opts.agentId ?? 'default'
  const model = opts.model ?? 'gpt-oss:20b'
  const host = (opts.ollamaHost ?? 'http://localhost:11434').replace(/\/$/, '')
  const workspaceDir = path.join(process.cwd(), 'workspaces', agentId)

  const prior = await readEvents(opts.sessionId)

  const userEv: SessionEvent = {
    id: uid(),
    ts: new Date().toISOString(),
    role: 'user',
    content: opts.userText,
    type: 'message',
  }
  await appendEvent(opts.sessionId, userEv)

  const events = [...prior, userEv]
  const workspaceMsgs = await loadWorkspaceMessages(agentId)

  const historyMsgs: OllamaMessage[] = events
    .filter((e) => e.type === 'message' && (e.role === 'user' || e.role === 'assistant' || e.role === 'system'))
    .map((e) => ({ role: e.role as any, content: e.content }))

  const messages: OllamaMessage[] = [...workspaceMsgs, ...historyMsgs]

  const maxToolSteps = 5

  for (let step = 0; step < maxToolSteps; step++) {
    const { content, toolCalls } = await callOllama(host, model, messages)

    if (toolCalls.length === 0) {
      const assistantEv: SessionEvent = {
        id: uid(),
        ts: new Date().toISOString(),
        role: 'assistant',
        content,
        type: 'message',
      }
      await appendEvent(opts.sessionId, assistantEv)
      return { assistantText: content }
    }

    const assistantToolCallEv: SessionEvent = {
      id: uid(),
      ts: new Date().toISOString(),
      role: 'assistant',
      content: content ?? '',
      type: 'toolCall',
    }
    await appendEvent(opts.sessionId, assistantToolCallEv)

    for (const tc of toolCalls) {
      const norm = normalizeToolCall(tc)

      const toolCallEv: SessionEvent = {
        id: uid(),
        ts: new Date().toISOString(),
        role: 'assistant',
        content: JSON.stringify({ tool: norm.tool, args: norm.args }),
        type: 'toolCall',
        tool: { name: norm.tool, args: norm.args },
      }
      await appendEvent(opts.sessionId, toolCallEv)

      let toolResult: { ok: boolean; result?: unknown; error?: string }
      try {
        toolResult = await runTool({ tool: norm.tool, args: norm.args }, workspaceDir)
      } catch (err: any) {
        toolResult = { ok: false, error: err?.message ?? String(err) }
      }

      const toolResultEv: SessionEvent = {
        id: uid(),
        ts: new Date().toISOString(),
        role: 'system',
        content: JSON.stringify({ toolResult: { tool: norm.tool, ...toolResult } }),
        type: 'toolResult',
        toolResult,
      }
      await appendEvent(opts.sessionId, toolResultEv)

      messages.push({
        role: 'tool',
        name: norm.tool,
        tool_call_id: norm.id,
        content: JSON.stringify(toolResult),
      })
    }
  }

  const assistantText = `Tool step limit reached (${maxToolSteps}).`
  const assistantEv: SessionEvent = {
    id: uid(),
    ts: new Date().toISOString(),
    role: 'assistant',
    content: assistantText,
    type: 'message',
  }
  await appendEvent(opts.sessionId, assistantEv)
  return { assistantText }
}
