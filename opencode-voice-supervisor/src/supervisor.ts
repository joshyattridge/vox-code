import { resolveOpenAiApiKey, type ResolvedApiKey } from "./auth.ts"
import { detectAudio, type AudioIO } from "./audio.ts"
import { persistVoiceState } from "./persist.ts"
import { voiceLog } from "./log.ts"
import { createSessionController, type SessionController } from "./sessions.ts"
import { openLive } from "./live.ts"
import { openRealtime, type RealtimeSession } from "./realtime.ts"
import {
  CUSTOM_REALTIME_MODEL,
  chipLabel,
  initialVoiceState,
  isLiveModel,
  resolveOptions,
  type VoiceOptions,
  type VoiceUiState,
} from "./types.ts"
import type { SessionClient } from "./client.ts"
import type { FocusHandler } from "./tools.ts"

export type SupervisorHooks = {
  toast?: (input: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  focusSession?: FocusHandler
  currentSessionId?: () => string | undefined
  onModelChange?: (model: string) => void
}

export type VoiceSupervisor = {
  state: () => VoiceUiState
  model: () => string
  chip: () => string
  subscribe: (listener: () => void) => () => void
  start: () => Promise<void>
  stop: (opts?: { silent?: boolean }) => Promise<void>
  toggle: () => Promise<void>
  mute: () => Promise<void>
  unmute: () => Promise<void>
  setModel: (model: string) => Promise<void>
  statusText: () => string
  handleIdle: (sessionId: string) => void
  handleError: (sessionId: string, message: string) => void
  handlePermission: (sessionId: string, permissionId: string, title: string) => void
  rebindAudio: (reason?: string) => Promise<void>
  setCurrentSession: (sessionId?: string) => void
  dispose: () => Promise<void>
}

const ECHO_HOLD_MS = 50

function isBenignVoiceError(message: string) {
  const text = message.toLowerCase()
  return (
    text.includes("cancellation failed") ||
    text.includes("no active response") ||
    text.includes("output_audio_buffer") ||
    text.includes("unknown event") ||
    text.includes("buffer") && text.includes("empty")
  )
}

export function createVoiceSupervisor(input: {
  client: SessionClient
  options?: VoiceOptions | Record<string, unknown>
  audio?: AudioIO
  directory?: string | (() => string | undefined)
  hooks?: SupervisorHooks
  connect?: typeof openRealtime | typeof openLive
  resolveKey?: () => ResolvedApiKey | Promise<ResolvedApiKey>
}): VoiceSupervisor {
  let options = resolveOptions(input.options as Record<string, unknown> | undefined)
  const directoryOf = () =>
    typeof input.directory === "function" ? input.directory() : input.directory
  const sessions: SessionController = createSessionController(input.client, directoryOf)
  const listeners = new Set<() => void>()
  let state: VoiceUiState = initialVoiceState()
  let realtime: RealtimeSession | undefined
  let audio: AudioIO | undefined = input.audio
  let starting = false
  let keySource = "missing"
  let speaking = false
  let playGeneration = 0
  let stopping = false
  let idlePoll: ReturnType<typeof setInterval> | undefined
  const lastIdleAt = new Map<string, number>()
  const lastBusy = new Set<string>()

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
    directory: directoryOf(),
  })

  const stopIdlePoll = () => {
    if (idlePoll) clearInterval(idlePoll)
    idlePoll = undefined
  }

  const handleIdle = (sessionId: string) => {
    void reportIdle(sessionId)
  }

  const reportIdle = async (sessionId: string) => {
    if (!sessions.ownedIds().includes(sessionId) || !realtime) return
    const now = Date.now()
    if ((lastIdleAt.get(sessionId) ?? 0) + 4000 > now) return
    lastIdleAt.set(sessionId, now)
    try {
      const st = await sessions.status(sessionId)
      const result = st.lastMessage?.trim()
      if (result) {
        realtime.injectText(`Session ${sessionId} finished. ${result}`)
        return
      }
      realtime.injectText(`Session ${sessionId} is idle with no result yet.`)
    } catch {
      realtime.injectText(`Session ${sessionId} is idle.`)
    }
  }

  const pollOwnedIdle = async () => {
    if (!realtime) return
    for (const id of sessions.ownedIds()) {
      try {
        const st = await sessions.status(id)
        if (st.status === "busy" || st.status === "running" || st.status === "retry") lastBusy.add(id)
        else if (lastBusy.delete(id)) handleIdle(id)
      } catch {
        // worker may live in another project; ignore a single poll miss
      }
    }
  }

  const sendMic = (chunk: Buffer) => {
    if (state.muted) return
    realtime?.sendAudio(chunk)
  }

  const start = async () => {
    if (starting || state.realtimeConnected) return
    const resolvedKey = await (input.resolveKey ??
      (() =>
        resolveOpenAiApiKey({
          pluginKey: options.apiKey,
          directory: directoryOf(),
        })))()
    if (!resolvedKey.key) {
      setState({ phase: "error", error: resolvedKey.hint })
      toast(resolvedKey.hint, "error")
      return
    }
    keySource = resolvedKey.source
    starting = true
    stopping = false
    setState({ phase: "connecting", error: undefined })
    try {
      audio = audio ?? detectAudio()
      await audio.startPlayback()
      voiceLog("audio io", audio.name)
      const connect =
        input.connect ?? ((opts) => (isLiveModel(opts.model) ? openLive(opts) : openRealtime(opts)))
      realtime = await connect({
        apiKey: resolvedKey.key,
        model: options.model,
        voice: options.voice,
        instructions: options.instructions,
        backendModel: options.backendModel,
        sessions,
        toolCtx,
        focus: input.hooks?.focusSession,
        handlers: {
          onOpen: () => {
            voiceLog("connected", options.model)
            setState({ phase: state.muted ? "muted" : "connected", realtimeConnected: true })
            toast("Voice connected.", "success")
          },
          onClose: () => {
            voiceLog("socket closed", { phase: state.phase, stopping })
            if (stopping || state.phase === "off") return
            void stop({ silent: true, reason: "socket" })
            toast("Voice disconnected.", "warning")
          },
          onError: (message) => {
            voiceLog("error", message)
            if (isBenignVoiceError(message)) return
            setState({ phase: "error", error: message, realtimeConnected: false })
            toast(message, "error")
          },
          onSpeechStarted: () => {
            if (!state.muted && state.phase !== "speaking") setState({ phase: "listening" })
          },
          onSpeechStopped: () => {
            if (!state.muted && state.realtimeConnected && !speaking) setState({ phase: "connected" })
          },
          onAudioDelta: (pcm) => {
            if (state.muted) return
            if (!speaking) playGeneration += 1
            speaking = true
            if (state.phase !== "speaking") setState({ phase: "speaking" })
            void audio?.play(pcm)
          },
          onAudioDone: async () => {
            const generation = playGeneration
            await audio?.drainPlayback()
            await new Promise((resolve) => setTimeout(resolve, ECHO_HOLD_MS))
            if (generation !== playGeneration) return
            speaking = false
            if (state.muted) setState({ phase: "muted" })
            else if (state.realtimeConnected) setState({ phase: "connected" })
          },
          onTranscript: (role, text) => {
            if (role === "user") setState({ lastUserTranscript: text })
            else setState({ lastAssistantTranscript: text })
          },
        },
      })
      await audio.startCapture(sendMic)
      if (!state.realtimeConnected) setState({ phase: "connected", realtimeConnected: true })
      stopIdlePoll()
      idlePoll = setInterval(() => {
        void pollOwnedIdle()
      }, 2500)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState({ phase: "error", error: message, realtimeConnected: false })
      toast(message, "error")
      await audio?.dispose().catch(() => undefined)
    } finally {
      starting = false
    }
  }

  const stop = async (opts?: { silent?: boolean; reason?: string }) => {
    voiceLog("stop", { reason: opts?.reason ?? "stop", phase: state.phase, silent: Boolean(opts?.silent) })
    stopping = true
    speaking = false
    stopIdlePoll()
    lastBusy.clear()
    realtime?.close()
    realtime = undefined
    await audio?.dispose().catch(() => undefined)
    if (!input.audio) audio = undefined
    setState({ phase: "off", realtimeConnected: false, muted: false, error: undefined })
    if (!opts?.silent) toast("Voice off.")
  }

  return {
    state: () => state,
    model: () => options.model,
    chip: () => chipLabel(state),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    stop,
    async toggle() {
      if (state.phase === "off" || state.phase === "error") await start()
      else await stop({ reason: "toggle" })
    },
    async setModel(model) {
      const next = model.trim()
      if (!next || next === CUSTOM_REALTIME_MODEL) return
      if (next === options.model) {
        toast(`Voice model is already ${next}.`)
        return
      }
      const live =
        state.realtimeConnected ||
        state.phase === "connecting" ||
        state.phase === "listening" ||
        state.phase === "speaking" ||
        state.phase === "muted"
      options = { ...options, model: next }
      input.hooks?.onModelChange?.(next)
      toast(`Voice model: ${next}`)
      notify()
      if (!live) return
      await stop({ silent: true, reason: "model" })
      await start()
    },
    async mute() {
      speaking = false
      state = { ...state, muted: true, phase: state.realtimeConnected ? "muted" : state.phase }
      realtime?.muteInput?.()
      await audio?.stopCapture()
      await audio?.stopPlayback()
      notify()
    },
    async unmute() {
      if (!state.realtimeConnected) return
      state = { ...state, muted: false, phase: speaking ? "speaking" : "connected" }
      realtime?.unmuteInput?.()
      if (audio) {
        await audio.startCapture(sendMic)
        await audio.startPlayback()
      }
      notify()
    },
    statusText() {
      const owned = sessions.ownedIds()
      const lines = [
        `phase: ${state.phase}`,
        `realtime: ${state.realtimeConnected ? "connected" : "down"}`,
        `model: ${options.model}`,
        isLiveModel(options.model) ? `backend: ${options.backendModel}` : undefined,
        `voice: ${options.voice}`,
        `api key: ${keySource}`,
        `owned sessions: ${owned.length ? owned.join(", ") : "(none)"}`,
      ].filter((line): line is string => Boolean(line))
      if (state.lastUserTranscript) lines.push(`heard: ${state.lastUserTranscript}`)
      if (state.lastAssistantTranscript) lines.push(`said: ${state.lastAssistantTranscript}`)
      if (state.error) lines.push(`error: ${state.error}`)
      return lines.join("\n")
    },
    handleIdle,
    handleError(sessionId, message) {
      if (!realtime) return
      realtime.injectText(`Session ${sessionId} error: ${message}.`)
    },
    handlePermission(sessionId, permissionId, title) {
      if (!realtime) return
      realtime.injectText(
        `Session ${sessionId} needs permission "${title}" (permission_id ${permissionId}). Ask the user, then call reply_permission if they decide.`,
      )
      toast(`Session needs permission: ${title}`, "warning")
    },
    async rebindAudio(reason = "session") {
      voiceLog("rebind skipped", reason)
    },
    setCurrentSession() {
      // TUI directory/session are read live from hooks in the daemon.
    },
    async dispose() {
      speaking = false
      stopIdlePoll()
      await stop({ reason: "dispose" })
      listeners.clear()
    },
  }
}
