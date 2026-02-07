import { appendEvent, readEvents, type SessionEvent } from './sessionStore.js'
import { readFile as readFileFs } from 'node:fs/promises'
import * as path from 'node:path'

import { tryParseToolCall } from './toolsProtocol.js'

type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string }

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

const ALLOWED_TOOLS = new Set(['fs.readText'])

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

  return { ok: false as const, error: `Tool not implemented: ${toolCall.tool}` }
}

async function loadWorkspaceMessages(agentId: string): Promise<OllamaMessage[]> {
  const workspaceDir = path.join(process.cwd(), 'workspaces', agentId)
  const [soul, tools] = await Promise.all([
    readFileFs(path.join(workspaceDir, 'SOUL.md'), 'utf8'),
    readFileFs(path.join(workspaceDir, 'TOOLS.md'), 'utf8')
  ])

  return [
    { role: 'system', content: soul },
    { role: 'system', content: tools }
  ]
}

async function callOllama(host: string, model: string, messages: OllamaMessage[]) {
  const resp = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false })
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Ollama error ${resp.status}: ${text}`)
  }

  const data = (await resp.json()) as { message?: { role: 'assistant'; content: string } }
  return data.message?.content ?? ''
}

export async function runTurn(opts: {
  sessionId: string
  userText: string
  agentId?: string
  model?: string
  ollamaHost?: string
}) {
  const agentId = opts.agentId ?? 'default'
  const model = opts.model ?? 'qwen3:8b'
  const host = (opts.ollamaHost ?? 'http://localhost:11434').replace(/\/$/, '')

  const workspaceDir = path.join(process.cwd(), 'workspaces', agentId)

  const prior = await readEvents(opts.sessionId)

  const userEv: SessionEvent = {
    id: uid(),
    ts: new Date().toISOString(),
    role: 'user',
    content: opts.userText,
    type: 'message'
  }
  await appendEvent(opts.sessionId, userEv)

  const events = [...prior, userEv]
  const workspaceMsgs = await loadWorkspaceMessages(agentId)
  const historyMsgs: OllamaMessage[] = events.map((e) => ({ role: e.role, content: e.content }))
  const messages: OllamaMessage[] = [...workspaceMsgs, ...historyMsgs]

  const maxToolSteps = 5

  for (let step = 0; step < maxToolSteps; step++) {
    const assistantText = await callOllama(host, model, messages)

    const toolCall = tryParseToolCall(assistantText)
    if (!toolCall) {
      const assistantEv: SessionEvent = {
        id: uid(),
        ts: new Date().toISOString(),
        role: 'assistant',
        content: assistantText,
        type: 'message'
      }
      await appendEvent(opts.sessionId, assistantEv)
      return { assistantText }
    }

    const toolCallEv: SessionEvent = {
      id: uid(),
      ts: new Date().toISOString(),
      role: 'assistant',
      content: assistantText,
      type: 'toolCall',
      tool: { name: toolCall.tool, args: toolCall.args }
    }
    await appendEvent(opts.sessionId, toolCallEv)

    let toolResult: { ok: boolean; result?: unknown; error?: string }
    try {
      toolResult = await runTool(toolCall, workspaceDir)
    } catch (err: any) {
      toolResult = { ok: false, error: err?.message ?? String(err) }
    }

    const toolResultPayload = { toolResult: { tool: toolCall.tool, ...toolResult } }

    const toolResultEv: SessionEvent = {
      id: uid(),
      ts: new Date().toISOString(),
      role: 'system',
      content: JSON.stringify(toolResultPayload),
      type: 'toolResult',
      toolResult
    }
    await appendEvent(opts.sessionId, toolResultEv)

    messages.push({ role: 'system', content: JSON.stringify(toolResultPayload) })
  }

  const assistantText = `Tool step limit reached (${maxToolSteps}).`
  const assistantEv: SessionEvent = {
    id: uid(),
    ts: new Date().toISOString(),
    role: 'assistant',
    content: assistantText,
    type: 'message'
  }
  await appendEvent(opts.sessionId, assistantEv)
  return { assistantText }
}
