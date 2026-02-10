// src/runTurn.ts

import { appendEvent, readEvents, type SessionEvent } from './sessionStore.js'
import { readFile as readFileFs } from 'node:fs/promises'
import * as path from 'node:path'

type OllamaMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'tool'; name: string; content: string; tool_call_id?: string }

type SearchResult = { title: string; link: string; snippet?: string }
type SearchEngine = 'duckduckgo' | 'google'

type OllamaToolCall = {
  id?: string
  function?: {
    name?: string
    arguments?: any
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isPlainObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function sanitizeToolName(name: any): string {
  if (typeof name !== 'string') return ''
  const stripped = name.replace(/assistant<\|channel\|>/g, '').trim()
  return stripped.replace(/[^a-zA-Z0-9._-]/g, '')
}

function resolveWorkspacePath(workspaceDir: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('args.path must be a non-empty string')
  if (path.isAbsolute(rel)) throw new Error('Absolute paths are not allowed')
  const resolved = path.resolve(workspaceDir, rel)
  const base = path.resolve(workspaceDir) + path.sep
  if (!resolved.startsWith(base)) throw new Error('Path escapes workspace')
  return resolved
}

/* =========================
   Tool runner
========================= */

const ALLOWED_TOOLS = new Set(['fs.readText'])

async function runTool(toolCall: { tool: string; args: unknown }, workspaceDir: string) {
  toolCall = { ...toolCall, tool: sanitizeToolName(toolCall.tool) }

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

  return { ok: false as const, error: `Tool not implemented: ${toolCall.tool}` }
}

/* =========================
   Workspace messages
========================= */

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

/* =========================
   Ollama chat (tool_calls)
========================= */

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
  if (data?.error) throw new Error(`Ollama returned error: ${data.error}`)

  const msg = data?.message ?? {}
  const content = typeof msg.content === 'string' ? msg.content : ''
  const toolCalls: OllamaToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : []

  return { raw: data, message: msg, content, toolCalls }
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

/* =========================
   runTurn
========================= */

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
