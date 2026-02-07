import { appendEvent, readEvents, type SessionEvent } from './sessionStore.js'

type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string }

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function runTurn(opts: {
    sessionId: string
    userText: string
    model?: string
    ollamaHost?: string
}) {
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
    const messages: OllamaMessage[] = events.map((e) => ({ role: e.role, content: e.content}))

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