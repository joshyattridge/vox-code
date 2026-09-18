export type VoicePhase =
  | "off"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "listening"
  | "speaking"
  | "error"

export type VoiceUiState = {
  phase: VoicePhase
  error?: string
  lastUserTranscript?: string
  lastAssistantTranscript?: string
  realtimeConnected: boolean
  desiredOn: boolean
  model?: string
  voice?: string
  customInstructions?: boolean
  reconnectAttempt?: number
  reconnectAt?: number
  sessionStartedAt?: number
  connectedSince?: number
  completedActiveMs?: number
  lastActivityAt?: number
  costWarningShown?: boolean
  ownedSessionIds: string[]
}

export type VoiceOptions = {
  model?: string
  voice?: string
  apiKey?: string
  keybind?: string
  instructions?: string
  backendModel?: string
  autoReconnect?: boolean
  inactivityTimeoutMinutes?: number
  costWarningMinutes?: number
  maxSessionDurationMinutes?: number
  autoStopOnOpenCodeExit?: boolean
}

export const DEFAULT_MODEL = "gpt-realtime"
export const DEFAULT_VOICE = "marin"
export const DEFAULT_KEYBIND = "ctrl+shift+v"
export const DEFAULT_BACKEND_MODEL = "gpt-5.6-luna"
export const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 10
export const DEFAULT_COST_WARNING_MINUTES = 30
export const DEFAULT_MAX_SESSION_DURATION_MINUTES = 60
export const SAMPLE_RATE = 24000
export const CUSTOM_REALTIME_MODEL = "__custom__"

export const LIVE_MODELS = [
  {
    id: "gpt-live-1",
    title: "gpt-live-1",
    description: "New GPT-Live · full duplex · $0.05/min",
  },
] as const

export const REALTIME_VOICES = [
  {
    id: "marin",
    title: "Marin",
    description: "Recommended · clear, natural, slightly bright",
    sample: "Hi, I'm Marin. I'll keep your coding sessions moving and skip the fluff.",
    category: "Recommended",
  },
  {
    id: "cedar",
    title: "Cedar",
    description: "Recommended · warm, grounded, slightly lower",
    sample: "Hey, this is Cedar. I'll stay calm and tell you when the workers finish.",
    category: "Recommended",
  },
  {
    id: "alloy",
    title: "Alloy",
    description: "Neutral and balanced",
    sample: "This is Alloy. Neutral tone, ready to dispatch coding work.",
    category: "More voices",
  },
  {
    id: "ash",
    title: "Ash",
    description: "Soft, slightly airy",
    sample: "Hi, I'm Ash. Soft-spoken, and I'll keep updates short.",
    category: "More voices",
  },
  {
    id: "ballad",
    title: "Ballad",
    description: "Warm, narrative, a bit slower",
    sample: "I'm Ballad. I'll narrate progress without reading your source code.",
    category: "More voices",
  },
  {
    id: "coral",
    title: "Coral",
    description: "Clear and upbeat",
    sample: "Coral here. I'll keep things upbeat and tell you when a worker is done.",
    category: "More voices",
  },
  {
    id: "echo",
    title: "Echo",
    description: "Smooth, even, slightly masculine",
    sample: "This is Echo. Smooth delivery, brief status, then back to work.",
    category: "More voices",
  },
  {
    id: "sage",
    title: "Sage",
    description: "Calm and measured",
    sample: "Sage speaking. Calm updates only: what changed, what's blocked.",
    category: "More voices",
  },
  {
    id: "shimmer",
    title: "Shimmer",
    description: "Bright and expressive",
    sample: "I'm Shimmer. I'll keep energy up and still stay to one or two sentences.",
    category: "More voices",
  },
  {
    id: "verse",
    title: "Verse",
    description: "Dynamic and expressive",
    sample: "Verse here. Expressive, but I'll still keep the spoken replies short.",
    category: "More voices",
  },
] as const

export type RealtimeVoiceId = (typeof REALTIME_VOICES)[number]["id"]

export function voiceMeta(id: string) {
  return REALTIME_VOICES.find((voice) => voice.id === id)
}

export function isRealtimeVoice(id: string): id is RealtimeVoiceId {
  return REALTIME_VOICES.some((voice) => voice.id === id)
}

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
): Required<
  Pick<
    VoiceOptions,
    | "model"
    | "voice"
    | "keybind"
    | "backendModel"
    | "autoReconnect"
    | "inactivityTimeoutMinutes"
    | "costWarningMinutes"
    | "maxSessionDurationMinutes"
    | "autoStopOnOpenCodeExit"
  >
> & VoiceOptions {
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
  const duration = (name: string, fallback: number) => {
    const value = raw?.[name]
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  const autoReconnect = typeof raw?.autoReconnect === "boolean" ? raw.autoReconnect : true
  const autoStopOnOpenCodeExit =
    typeof raw?.autoStopOnOpenCodeExit === "boolean" ? raw.autoStopOnOpenCodeExit : true
  const inactivityTimeoutMinutes = duration("inactivityTimeoutMinutes", DEFAULT_INACTIVITY_TIMEOUT_MINUTES)
  const costWarningMinutes = duration("costWarningMinutes", DEFAULT_COST_WARNING_MINUTES)
  const maxSessionDurationMinutes = duration("maxSessionDurationMinutes", DEFAULT_MAX_SESSION_DURATION_MINUTES)
  return {
    model,
    voice,
    keybind,
    backendModel,
    apiKey,
    instructions,
    autoReconnect,
    autoStopOnOpenCodeExit,
    inactivityTimeoutMinutes,
    costWarningMinutes,
    maxSessionDurationMinutes,
  }
}

export function normalizeVoiceState(state: VoiceUiState): VoiceUiState {
  if (state.phase === "error") {
    return { ...state, realtimeConnected: false }
  }
  if (state.phase === "connecting" || state.phase === "reconnecting") {
    return { ...state, realtimeConnected: false }
  }
  if (!state.realtimeConnected) {
    return { ...state, phase: "off" }
  }
  return state
}

export function chipLabel(state: VoiceUiState): string {
  const normalized = normalizeVoiceState(state)
  switch (normalized.phase) {
    case "off":
      return "○ voice"
    case "error":
      return "● error"
    case "connecting":
      return "◌ voice"
    case "reconnecting":
      return "◌ reconnecting"
    default:
      return "● VOICE"
  }
}

export function initialVoiceState(): VoiceUiState {
  return {
    phase: "off",
    realtimeConnected: false,
    desiredOn: false,
    ownedSessionIds: [],
  }
}
