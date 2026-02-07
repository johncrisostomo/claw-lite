export type ToolCall = { tool: string; args: unknown }

export function tryParseToolCall(assistantText: string): ToolCall | null {
    const txt = assistantText.trim()

    if (!txt.startsWith('{') || !txt.endsWith('}')) return null

    let obj: any
    try {
        obj = JSON.parse(txt)
    } catch {
        return null
    }

    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null
    if (typeof obj.tool !== 'string' || obj.tool.length === 0) return null
    if (!('args' in obj)) return null

    return { tool: obj.tool, args: obj.args }
}