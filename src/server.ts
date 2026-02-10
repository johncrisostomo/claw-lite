// src/server.ts
import express from 'express'
import path from 'node:path'
import qrcode from 'qrcode-terminal'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'

import { runTurn } from './core/runTurn.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

const WA_ENABLE = String(process.env.WA_ENABLE ?? 'true') === 'true'
const WA_PREFIX = String(process.env.WA_PREFIX ?? '/ai ').trimEnd() + ' '
const WA_AGENT_ID = String(process.env.WA_AGENT_ID ?? process.env.AGENT_ID ?? 'default')

let waSock: any | null = null
let waStarting: Promise<void> | null = null

// Loop prevention: remember message IDs we sent, ignore if they come back in upsert.
const SENT_IDS = new Set<string>()
const SENT_QUEUE: string[] = []
const SENT_MAX = 300

function rememberSent(id: unknown) {
  const s = typeof id === 'string' ? id : ''
  if (!s) return
  if (SENT_IDS.has(s)) return
  SENT_IDS.add(s)
  SENT_QUEUE.push(s)
  while (SENT_QUEUE.length > SENT_MAX) {
    const old = SENT_QUEUE.shift()
    if (old) SENT_IDS.delete(old)
  }
}

function extractText(msg: any): string {
  const m = msg?.message
  return (
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    ''
  )
}

function isDirectChat(remoteJid: string): boolean {
  return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')
}

function isGroupOrBroadcast(remoteJid: string): boolean {
  return (
    remoteJid.endsWith('@g.us') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@broadcast')
  )
}

async function startWhatsApp() {
  if (!WA_ENABLE) return
  if (waSock) return
  if (waStarting) return waStarting

  waStarting = (async () => {
    const workspaceDir = path.join(process.cwd(), 'workspaces', WA_AGENT_ID)
    const authDir = path.join(workspaceDir, '.wa-auth')

    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    const sock = makeWASocket({
      auth: state,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    })
    waSock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update: any) => {
      const { connection, lastDisconnect, qr } = update ?? {}

      if (qr && !state.creds.registered) qrcode.generate(qr, { small: true })

      if (connection === 'open') {
        console.error('[wa] connected')
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error as Boom | undefined
        const statusCode = err?.output?.statusCode
        console.error('[wa] disconnected', statusCode ?? 'unknown')

        waSock = null
        waStarting = null

        if (statusCode === DisconnectReason.loggedOut) {
          console.error('[wa] logged out; delete %s and re-pair', authDir)
          return
        }

        setTimeout(() => void startWhatsApp(), 1000)
      }
    })

    sock.ev.on('chats.upsert', (c: any) => {
      console.error('[wa] chats.upsert', Array.isArray(c) ? c.length : typeof c)
    })

    sock.ev.on('messages.upsert', async (m: any) => {
      const msgs = m?.messages ?? []
      console.error('[wa] upsert type=', m?.type, 'count=', msgs.length)

      for (const msg of msgs) {
        const remoteJid = msg?.key?.remoteJid as string | undefined
        const msgId = msg?.key?.id as string | undefined
        const fromMe = !!msg?.key?.fromMe
        const text = extractText(msg).trim()

        console.error('[wa] msg', { remoteJid, fromMe, id: msgId, text })

        if (!remoteJid) continue
        if (isGroupOrBroadcast(remoteJid)) continue
        if (!isDirectChat(remoteJid)) continue

        // loop-prevention: ignore IDs we know we sent
        if (msgId && SENT_IDS.has(String(msgId))) continue

        const prefix = WA_PREFIX.trimEnd()
        if (!text.startsWith(prefix)) continue

        const userText = text.slice(prefix.length).trim()
        if (!userText) continue

        const sessionId = `wa_self_${remoteJid}`
        const model = String(process.env.OLLAMA_MODEL ?? 'gpt-oss:20b')
        const ollamaHost = String(process.env.OLLAMA_HOST ?? 'http://localhost:11434')

        try {
          const out = await runTurn({
            sessionId,
            userText,
            agentId: WA_AGENT_ID,
            model,
            ollamaHost,
          })

          const sent = await sock.sendMessage(remoteJid, { text: out.assistantText })
          rememberSent(sent?.key?.id)
        } catch (e: any) {
          const sent = await sock.sendMessage(remoteJid, { text: `Error: ${e?.message ?? String(e)}` })
          rememberSent(sent?.key?.id)
        }
      }
    })
  })()

  return waStarting
}

app.post('/chat', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? 'main')
    const userText = String(req.body?.text ?? '')
    if (!userText.trim()) return res.status(400).json({ error: 'Missing text' })

    const model = String(req.body?.model ?? process.env.OLLAMA_MODEL ?? 'gpt-oss:20b')
    const ollamaHost = String(process.env.OLLAMA_HOST ?? 'http://localhost:11434')

    const out = await runTurn({ sessionId, userText, model, ollamaHost })
    res.json({ sessionId, reply: out.assistantText })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

app.post('/wa/start', async (_req, res) => {
  await startWhatsApp()
  res.json({ ok: true, enabled: WA_ENABLE, prefix: WA_PREFIX, agentId: WA_AGENT_ID })
})

const port = Number(process.env.PORT ?? 3333)
app.listen(port, () => {
  console.log(`http://localhost:${port}`)
  void startWhatsApp()
})
