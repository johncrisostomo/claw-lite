import { runTurn } from './core/runTurn.js'

const userText = process.argv.slice(2).join(' ').trim()

if (!userText) {
    console.error('Usage: pnpm chat "hello"')
    process.exit(1)
}

const sessionId = process.env.SESSION_ID ?? 'main'
const model = process.env.OLLAMA_MODEL ?? 'qwen3:8b'
const ollamaHost = process.env.OLLAMA_HOST ?? 'http://localhost:11434'

const { assistantText } = await runTurn({ sessionId, userText, model, ollamaHost })
process.stdout.write(assistantText + '\n')