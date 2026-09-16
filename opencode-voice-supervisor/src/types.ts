export type VoicePhase =
  | "off"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "muted"
  | "error"

export type VoiceUiState = {
  phase: VoicePhase
  error?: string
  lastUserTranscript?: string
  lastAssistantTranscript?: string
  realtimeConnected: boolean
  muted: boolean
  ownedSessionIds: string[]
}

export type VoiceOptions = {
  model?: string
  voice?: string
  apiKey?: string
  keybind?: string
  instructions?: string
}

export type SessionSnapshot = {
  id: string
  title: string
  directory?: string
  status: string
  owned: boolean
}

export type PermissionReply = "once" | "always" | "reject"

export const DEFAULT_MODEL = "gpt-realtime"
export const DEFAULT_VOICE = "marin"
export const DEFAULT_KEYBIND = "ctrl+shift+v"
export const SAMPLE_RATE = 24000

export function resolveOptions(raw: Record<string, unknown> | undefined): Required<Pick<VoiceOptions, "model" | "voice" | "keybind">> & VoiceOptions {
  const model =
    (typeof raw?.model === "string" && raw.model) ||
    process.env.OPENAI_REALTIME_MODEL ||
    DEFAULT_MODEL
  const voice =
    (typeof raw?.voice === "string" && raw.voice) ||
    process.env.OPENAI_REALTIME_VOICE ||
    DEFAULT_VOICE
  const keybind =
    (typeof raw?.keybind === "string" && raw.keybind) || DEFAULT_KEYBIND
  const apiKey = typeof raw?.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined
  const instructions = typeof raw?.instructions === "string" ? raw.instructions : undefined
  return { model, voice, keybind, apiKey, instructions }
}

export function chipLabel(state: VoiceUiState): string {
  switch (state.phase) {
    case "off":
      return "○ voice"
    case "connecting":
      return "● …"
    case "connected":
      return "● VOICE"
    case "listening":
      return "● listening"
    case "speaking":
      return "● speaking"
    case "muted":
      return "● muted"
    case "error":
      return "● error"
  }
}

export function initialVoiceState(): VoiceUiState {
  return {
    phase: "off",
    realtimeConnected: false,
    muted: false,
    ownedSessionIds: [],
  }
}
