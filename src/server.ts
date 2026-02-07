import express from 'express'
import { runTurn } from './core/runTurn.js'

const app = express()
app.use(express.json({ limit: '1mb'}))

app.post('/chat', async (req, res) => {
    try {
        const sessionId = String(req.body?.sessionId ?? 'main')
        const userText = String(req.body?.text ?? '')
        if (!userText.trim()) return res.status(400).json({ error: 'Missing text'})
        
        const model = String(req.body?.model ?? process.env.OLLAMA_MODEL ?? 'gpt-oss:20b')
        const ollamaHost = String(process.env.OLLAMA_HOST ?? 'http://localhost:11434')

        const out = await runTurn({ sessionId, userText, model, ollamaHost })
        res.json({ sessionId, reply: out.assistantText })
    } catch (e: any) {
        res.status(500).json({ error: e?.message ?? String(e) })
    }
})

const port = Number(process.env.PORT ?? 3333)
app.listen(port, () => {
    console.log(`http://localhost:${port}`)
})