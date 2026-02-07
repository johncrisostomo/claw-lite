import { appendEvent, readEvents, type SessionEvent } from './sessionStore.js'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string }

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function loadWorkspaceMessages(agentId: string): Promise<OllamaMessage[]> {
    const workspaceDir = path.join(process.cwd(), 'workspaces', agentId)
    const [soul, tools] = await Promise.all([
        readFile(path.join(workspaceDir, 'SOUL.md'), 'utf8'),
        readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8')
    ])

    return [
        { role: 'system', content: soul },
        { role: 'system', content: tools}
    ]
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

    const prior = await readEvents(opts.sessionId)

    const userEv: SessionEvent = {
        id: uid(),
        ts: new Date().toISOString(),
        role: 'user',
        content: opts.userText
    }
    await appendEvent(opts.sessionId, userEv)

    const events = [...prior, userEv]
    const workspaceMsgs = await loadWorkspaceMessages(agentId)
    const historyMsgs: OllamaMessage[] = events.map((e) => ({ role: e.role, content: e.content }))
    const messages: OllamaMessage[] = [...workspaceMsgs, ...historyMsgs]

    const resp = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false})
    })

    if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`Ollama error ${resp.status}: ${text}`)
    }

    const data = (await resp.json()) as { message?: { role: 'assistant'; content: string}}
    const assistantText = data.message?.content ?? ''

    const assistantEv: SessionEvent = {
        id: uid(),
        ts: new Date().toISOString(),
        role: 'assistant',
        content: assistantText,
    }
    await appendEvent(opts.sessionId, assistantEv)

    return { assistantText }
}