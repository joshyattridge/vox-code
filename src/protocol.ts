import type { VoiceUiState } from "./types.ts"

export type ClientConfig = {
  baseUrl?: string
  headers?: Record<string, string>
}

export const VOICE_PROTOCOL = 7

export type UpMessage =
  | { type: "hello"; directory?: string; options?: Record<string, unknown>; client?: ClientConfig; sessionId?: string }
  | { type: "start" }
  | { type: "stop"; silent?: boolean }
  | { type: "toggle" }
  | { type: "setModel"; model: string }
  | { type: "setVoice"; voice: string }
  | { type: "setInstructions"; instructions?: string }
  | { type: "previewVoice"; voice: string }
  | { type: "idle"; sessionId: string }
  | { type: "sessionError"; sessionId: string; message: string }
  | { type: "permission"; sessionId: string; permissionId: string; title: string }
  | { type: "currentSession"; sessionId?: string }
  | { type: "rpcResult"; id: string; data?: unknown; error?: unknown }
  | { type: "focusResult"; sessionId: string; focused: boolean }

export type DownMessage =
  | { type: "ready"; protocol?: number }
  | { type: "state"; state: VoiceUiState; model: string; voice: string; instructions?: string; statusText: string }
  | { type: "toast"; message: string; variant?: "info" | "success" | "warning" | "error" }
  | { type: "focus"; sessionId: string; directory?: string }
  | { type: "rpc"; id: string; op: string; params?: unknown }

export function encodeMessage(message: object) {
  return `${JSON.stringify(message)}\n`
}

export function splitMessages(buffer: string): { messages: unknown[]; rest: string } {
  const parts = buffer.split("\n")
  const rest = parts.pop() ?? ""
  const messages: unknown[] = []
  for (const part of parts) {
    if (!part.trim()) continue
    try {
      messages.push(JSON.parse(part) as unknown)
    } catch {
      // drop a malformed line
    }
  }
  return { messages, rest }
}

export function extractClientConfig(client: unknown): ClientConfig {
  const seen = new Set<unknown>()
  const stack: unknown[] = [client]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const record = current as {
      getConfig?: () => { baseUrl?: string; headers?: HeadersInit }
      buildUrl?: (input: { url: string }) => unknown
      client?: unknown
      _client?: unknown
      baseUrl?: string
    }
    if (typeof record.getConfig === "function") {
      try {
        const cfg = record.getConfig()
        if (cfg?.baseUrl) {
          return { baseUrl: String(cfg.baseUrl), headers: headersToRecord(cfg.headers) }
        }
      } catch {
        // keep walking
      }
    }
    if (typeof record.buildUrl === "function") {
      try {
        const built = (record as { buildUrl: (input: { url: string }) => unknown }).buildUrl({ url: "/session" })
        if (typeof built === "string" && /^https?:\/\//.test(built)) {
          const parsed = new URL(built)
          return { baseUrl: parsed.origin }
        }
      } catch {
        // keep walking
      }
    }
    if (typeof record.baseUrl === "string" && record.baseUrl.startsWith("http")) {
      return { baseUrl: record.baseUrl }
    }
    if (record.client) stack.push(record.client)
    if (record._client) stack.push(record._client)
  }
  return {}
}

function headersToRecord(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}
