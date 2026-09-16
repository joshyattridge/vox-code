import { resolveOpenAiApiKey, type ResolvedApiKey } from "./auth.ts"
import { detectAudio, type AudioIO } from "./audio.ts"
import { persistVoiceState } from "./persist.ts"
import { createSessionController, type SessionController } from "./sessions.ts"
import { openRealtime, type RealtimeSession } from "./realtime.ts"
import { chipLabel, initialVoiceState, resolveOptions, type VoiceOptions, type VoiceUiState } from "./types.ts"
import type { SessionClient } from "./client.ts"
import type { FocusHandler } from "./tools.ts"

export type SupervisorHooks = {
  toast?: (input: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  focusSession?: FocusHandler
  currentSessionId?: () => string | undefined
}

export type VoiceSupervisor = {
  state: () => VoiceUiState
  chip: () => string
  subscribe: (listener: () => void) => () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  toggle: () => Promise<void>
  mute: () => Promise<void>
  unmute: () => Promise<void>
  statusText: () => string
  handleIdle: (sessionId: string) => void
  handleError: (sessionId: string, message: string) => void
  handlePermission: (sessionId: string, permissionId: string, title: string) => void
  dispose: () => Promise<void>
}

export function createVoiceSupervisor(input: {
  client: SessionClient
  options?: VoiceOptions | Record<string, unknown>
  audio?: AudioIO
  directory?: string
  hooks?: SupervisorHooks
  connect?: typeof openRealtime
  resolveKey?: () => ResolvedApiKey | Promise<ResolvedApiKey>
}): VoiceSupervisor {
  const options = resolveOptions(input.options as Record<string, unknown> | undefined)
  const sessions: SessionController = createSessionController(input.client, input.directory)
  const listeners = new Set<() => void>()
  let state: VoiceUiState = initialVoiceState()
  let realtime: RealtimeSession | undefined
  let audio: AudioIO | undefined = input.audio
  let starting = false
  let keySource = "missing"

  const notify = () => {
    persistVoiceState(state)
    for (const listener of listeners) listener()
  }

  const setState = (patch: Partial<VoiceUiState>) => {
    state = { ...state, ...patch, ownedSessionIds: sessions.ownedIds() }
    notify()
  }

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    input.hooks?.toast?.({ title: "Voice", message, variant })
  }

  const toolCtx = () => ({
    currentSessionId: input.hooks?.currentSessionId?.(),
    warnSharedCheckout: true,
  })

  const start = async () => {
    if (starting || state.realtimeConnected) return
    const resolvedKey = await (input.resolveKey ??
      (() =>
        resolveOpenAiApiKey({
          pluginKey: options.apiKey,
          directory: input.directory,
        })))()
    if (!resolvedKey.key) {
      setState({ phase: "error", error: resolvedKey.hint })
      toast(resolvedKey.hint, "error")
      return
    }
    keySource = resolvedKey.source
    starting = true
    setState({ phase: "connecting", error: undefined })
    try {
      audio = audio ?? detectAudio()
      const connect = input.connect ?? openRealtime
      realtime = await connect({
        apiKey: resolvedKey.key,
        model: options.model,
        voice: options.voice,
        instructions: options.instructions,
        sessions,
        toolCtx: toolCtx(),
        focus: input.hooks?.focusSession,
        handlers: {
          onOpen: () => {
            setState({ phase: state.muted ? "muted" : "connected", realtimeConnected: true })
            toast("Voice connected.", "success")
          },
          onClose: () => {
            setState({ phase: "off", realtimeConnected: false })
          },
          onError: (message) => {
            setState({ phase: "error", error: message, realtimeConnected: false })
            toast(message, "error")
          },
          onSpeechStarted: () => {
            void audio?.stopPlayback()
            if (!state.muted) setState({ phase: "listening" })
          },
          onSpeechStopped: () => {
            if (!state.muted && state.realtimeConnected) setState({ phase: "connected" })
          },
          onAudioDelta: (pcm) => {
            if (state.muted) return
            setState({ phase: "speaking" })
            void audio?.play(pcm)
          },
          onAudioDone: () => {
            if (state.muted) setState({ phase: "muted" })
            else if (state.realtimeConnected) setState({ phase: "connected" })
          },
          onTranscript: (role, text) => {
            if (role === "user") setState({ lastUserTranscript: text })
            else setState({ lastAssistantTranscript: text })
          },
        },
      })
      await audio.startCapture((chunk) => {
        if (state.muted) return
        realtime?.sendAudio(chunk)
      })
      if (!state.realtimeConnected) setState({ phase: "connected", realtimeConnected: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState({ phase: "error", error: message, realtimeConnected: false })
      toast(message, "error")
      await audio?.dispose().catch(() => undefined)
    } finally {
      starting = false
    }
  }

  const stop = async () => {
    realtime?.close()
    realtime = undefined
    await audio?.dispose().catch(() => undefined)
    if (!input.audio) audio = undefined
    setState({ phase: "off", realtimeConnected: false, muted: false, error: undefined })
    toast("Voice off.")
  }

  return {
    state: () => state,
    chip: () => chipLabel(state),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    stop,
    async toggle() {
      if (state.phase === "off" || state.phase === "error") await start()
      else await stop()
    },
    async mute() {
      state = { ...state, muted: true, phase: state.realtimeConnected ? "muted" : state.phase }
      await audio?.stopCapture()
      await audio?.stopPlayback()
      notify()
    },
    async unmute() {
      if (!state.realtimeConnected) return
      state = { ...state, muted: false, phase: "connected" }
      if (audio) {
        await audio.startCapture((chunk) => realtime?.sendAudio(chunk))
      }
      notify()
    },
    statusText() {
      const owned = sessions.ownedIds()
      const lines = [
        `phase: ${state.phase}`,
        `realtime: ${state.realtimeConnected ? "connected" : "down"}`,
        `model: ${options.model}`,
        `voice: ${options.voice}`,
        `api key: ${keySource}`,
        `owned sessions: ${owned.length ? owned.join(", ") : "(none)"}`,
      ]
      if (state.lastUserTranscript) lines.push(`heard: ${state.lastUserTranscript}`)
      if (state.lastAssistantTranscript) lines.push(`said: ${state.lastAssistantTranscript}`)
      if (state.error) lines.push(`error: ${state.error}`)
      return lines.join("\n")
    },
    handleIdle(sessionId) {
      if (!sessions.ownedIds().includes(sessionId) || !realtime) return
      realtime.injectText(
        `System: worker session ${sessionId} is idle (finished or waiting). Give the user a one-sentence spoken update. Use session_status if you need a diff summary.`,
      )
    },
    handleError(sessionId, message) {
      if (!realtime) return
      realtime.injectText(`System: session ${sessionId} error: ${message}. Tell the user briefly.`)
    },
    handlePermission(sessionId, permissionId, title) {
      if (!realtime) return
      realtime.injectText(
        `System: session ${sessionId} needs permission "${title}" (permission_id ${permissionId}). Ask the user, then call reply_permission if they decide.`,
      )
      toast(`Session needs permission: ${title}`, "warning")
    },
    async dispose() {
      await stop()
      listeners.clear()
    },
  }
}
