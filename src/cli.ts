import { runTurn } from './core/runTurn.js'

const userText = process.argv.slice(2).join(' ').trim()

if (!userText) {
    console.error('Usage: pnpm chat "hello"')
    process.exit(1)
}

const sessionId = process.env.SESSION_ID ?? 'main'
const agentId = process.env.AGENT_ID ?? 'default'
const model = process.env.OLLAMA_MODEL ?? 'gpt-oss:20b'
const ollamaHost = process.env.OLLAMA_HOST ?? 'http://localhost:11434'

const { assistantText } = await runTurn({ sessionId, userText, agentId, model, ollamaHost })
process.stdout.write(assistantText + '\n')