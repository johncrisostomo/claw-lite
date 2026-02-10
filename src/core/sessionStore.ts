import { mkdir, readFile, appendFile } from 'node:fs/promises'
import * as path from 'node:path'

export type SessionEvent = {
  id: string
  ts: string
  role: 'user' | 'assistant' | 'system'
  content: string
  type: 'message' | 'toolCall' | 'toolResult'
  tool?: { name: string; args: any }
  toolResult?: any
}

const ROOT = path.join(process.cwd(), 'state', 'sessions')

function safeSessionId(sessionId: string) {
  return sessionId.replace(/[^a-zA-Z0-9._@-]/g, '_')
}

async function ensureSessionsDir() {
  await mkdir(ROOT, { recursive: true })
}

function sessionPath(sessionId: string) {
  return path.join(ROOT, `${safeSessionId(sessionId)}.jsonl`)
}

export async function readEvents(sessionId: string): Promise<SessionEvent[]> {
  await ensureSessionsDir()
  const p = sessionPath(sessionId)
  try {
    const txt = await readFile(p, 'utf8')
    return txt
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionEvent)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
}

export async function appendEvent(sessionId: string, ev: SessionEvent) {
  await ensureSessionsDir()
  const p = sessionPath(sessionId)
  await appendFile(p, JSON.stringify(ev) + '\n', 'utf8')
}
