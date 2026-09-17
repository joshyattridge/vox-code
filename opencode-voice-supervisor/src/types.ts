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
  backendModel?: string
}

export const DEFAULT_MODEL = "gpt-realtime"
export const DEFAULT_VOICE = "marin"
export const DEFAULT_KEYBIND = "ctrl+shift+v"
export const DEFAULT_BACKEND_MODEL = "gpt-5.6-luna"
export const SAMPLE_RATE = 24000
export const CUSTOM_REALTIME_MODEL = "__custom__"

export const LIVE_MODELS = [
  {
    id: "gpt-live-1",
    title: "gpt-live-1",
    description: "New GPT-Live · full duplex · $0.05/min",
  },
] as const

export const REALTIME_MODELS = [
  {
    id: "gpt-realtime",
    title: "gpt-realtime",
    description: "GA Realtime · ~$0.05–0.12/min",
  },
  {
    id: "gpt-realtime-2.1",
    title: "gpt-realtime-2.1",
    description: "Latest flagship · $32/$64 per 1M audio tokens",
  },
  {
    id: "gpt-realtime-2.1-mini",
    title: "gpt-realtime-2.1-mini",
    description: "Cheaper · $10/$20 per 1M audio tokens",
  },
] as const

export function isLiveModel(model: string) {
  return model === "gpt-live-1" || model.startsWith("gpt-live-")
}

export type SessionSnapshot = {
  id: string
  title: string
  directory?: string
  status: string
  owned: boolean
}

export type PermissionReply = "once" | "always" | "reject"

export function resolveOptions(
  raw: Record<string, unknown> | undefined,
): Required<Pick<VoiceOptions, "model" | "voice" | "keybind" | "backendModel">> & VoiceOptions {
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
  const backendModel =
    (typeof raw?.backendModel === "string" && raw.backendModel) ||
    process.env.OPENAI_LIVE_BACKEND_MODEL ||
    DEFAULT_BACKEND_MODEL
  const apiKey = typeof raw?.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined
  const instructions = typeof raw?.instructions === "string" ? raw.instructions : undefined
  return { model, voice, keybind, backendModel, apiKey, instructions }
}

export function chipLabel(state: VoiceUiState): string {
  switch (state.phase) {
    case "off":
      return "○ voice"
    case "muted":
      return "● muted"
    case "error":
      return "● error"
    default:
      return "● VOICE"
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
