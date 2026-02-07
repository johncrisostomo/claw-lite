import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export type Role = 'system' | 'user' | 'assistant'

export type SessionEvent = {
    id: string
    ts: string
    role: Role
    content: string
    type?: 'message' | 'toolCall' | 'toolResult'
    tool?: { name: string; args: unknown }
    toolResult?: { ok: boolean; result?: unknown; error?: string }
}

export async function ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true })
}

export function sessionPath(sessionId: string) {
    return path.join(process.cwd(), 'state', 'sessions', `${sessionId}.jsonl`)
}

export async function appendEvent(sessionId: string, ev: SessionEvent) {
    const file = sessionPath(sessionId)
    await ensureDir(path.dirname(file))
    await fs.appendFile(file, JSON.stringify(ev) + '\n', 'utf8')
}

export async function readEvents(sessionId: string): Promise<SessionEvent[]> {
    const file = sessionPath(sessionId)
    try {
        const txt = await fs.readFile(file, 'utf8')
        return txt
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as SessionEvent)
    } catch (err: any) {
        if (err?.code === 'ENOENT') return []
        throw err
    }
}