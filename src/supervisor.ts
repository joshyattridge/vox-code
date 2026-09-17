import { resolveOpenAiApiKey, type ResolvedApiKey } from "./auth.ts"
import { detectAudio, playPcmClip, type AudioIO } from "./audio.ts"
import { persistVoiceState } from "./persist.ts"
import { voiceLog } from "./log.ts"
import { createSessionController, type SessionController } from "./sessions.ts"
import { openLive } from "./live.ts"
import { fetchVoiceSamplePcm } from "./preview.ts"
import { defaultSpokenInstructions } from "./instructions.ts"
import { openRealtime, type RealtimeSession } from "./realtime.ts"
import {
  CUSTOM_REALTIME_MODEL,
  chipLabel,
  initialVoiceState,
  SAMPLE_RATE,
  isLiveModel,
  normalizeVoiceState,
  resolveOptions,
  voiceMeta,
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
  onVoiceChange?: (voice: string) => void
  onInstructionsChange?: (instructions?: string) => void
}

export type VoiceSupervisor = {
  state: () => VoiceUiState
  model: () => string
  voice: () => string
  instructions: () => string | undefined
  chip: () => string
  subscribe: (listener: () => void) => () => void
  start: () => Promise<void>
  stop: (opts?: { silent?: boolean }) => Promise<void>
  toggle: () => Promise<void>
  setModel: (model: string) => Promise<void>
  setVoice: (voice: string) => Promise<void>
  setInstructions: (instructions?: string) => Promise<void>
  previewVoice: (voice: string) => Promise<void>
  statusText: () => string
  handleIdle: (sessionId: string) => void
  handleError: (sessionId: string, message: string) => void
  handlePermission: (sessionId: string, permissionId: string, title: string) => void
  rebindAudio: (reason?: string) => Promise<void>
  setCurrentSession: (sessionId?: string) => void
  dispose: () => Promise<void>
}

const ECHO_HOLD_MS = 300

function playbackMs(bytes: number) {
  return Math.ceil((bytes / 2 / SAMPLE_RATE) * 1000)
}

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
  fetchSpeech?: typeof fetchVoiceSamplePcm
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
  let spokenBytes = 0
  let speakStartedAt = 0
  let stopping = false
  let idlePoll: ReturnType<typeof setInterval> | undefined
  const lastIdleAt = new Map<string, number>()
  const lastBusy = new Set<string>()

  const notify = () => {
    persistVoiceState(state)
    for (const listener of listeners) listener()
  }

  const setState = (patch: Partial<VoiceUiState>) => {
    state = normalizeVoiceState({ ...state, ...patch, ownedSessionIds: sessions.ownedIds() })
    notify()
  }

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    input.hooks?.toast?.({ title: "Vox Code", message, variant })
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
    // Realtime VAD has no echo cancellation on sox. Hold the mic while the
    // assistant is playing so speaker bleed does not barge in on itself.
    if (speaking && !isLiveModel(options.model)) return
    realtime?.sendAudio(chunk)
  }

  const sessionActive = () => Boolean(realtime) && !stopping && state.phase !== "off"

  const start = async () => {
    if (starting || stopping || state.realtimeConnected || sessionActive()) return
    starting = true
    stopping = false
    const resolvedKey = await (input.resolveKey ??
      (() =>
        resolveOpenAiApiKey({
          pluginKey: options.apiKey,
          directory: directoryOf(),
        })))()
    if (!resolvedKey.key) {
      starting = false
      setState({ phase: "error", error: resolvedKey.hint, realtimeConnected: false })
      toast(resolvedKey.hint, "error")
      return
    }
    keySource = resolvedKey.source
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
            if (stopping) return
            voiceLog("connected", options.model)
            setState({ phase: "connected", realtimeConnected: true })
            toast("Vox Code connected.", "success")
          },
          onClose: () => {
            voiceLog("socket closed", { phase: state.phase, stopping })
            if (stopping || state.phase === "off") return
            void stop({ silent: true, reason: "socket" })
            toast("Vox Code disconnected.", "warning")
          },
          onError: (message) => {
            voiceLog("error", message)
            if (stopping || isBenignVoiceError(message)) return
            setState({ phase: "error", error: message, realtimeConnected: false })
            toast(message, "error")
          },
          onSpeechStarted: () => {
            if (!sessionActive()) return
            voiceLog("heard speech", { speaking, phase: state.phase, model: options.model })
            if (speaking && !isLiveModel(options.model)) return
            setState({ phase: "listening" })
          },
          onSpeechStopped: () => {
            if (!sessionActive() || speaking) return
            setState({ phase: "connected" })
          },
          onAudioDelta: (pcm) => {
            if (!sessionActive()) return
            if (!speaking) {
              playGeneration += 1
              spokenBytes = 0
              speakStartedAt = Date.now()
            }
            speaking = true
            spokenBytes += pcm.length
            if (state.phase !== "speaking") setState({ phase: "speaking", realtimeConnected: true })
            void audio?.play(pcm)
          },
          onAudioDone: async () => {
            const generation = playGeneration
            const remaining = Math.max(0, playbackMs(spokenBytes) - (Date.now() - speakStartedAt))
            if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining))
            await audio?.drainPlayback()
            await new Promise((resolve) => setTimeout(resolve, ECHO_HOLD_MS))
            if (generation !== playGeneration || !sessionActive()) return
            speaking = false
            spokenBytes = 0
            speakStartedAt = 0
            if (state.realtimeConnected) setState({ phase: "connected" })
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
    if (stopping && state.phase === "off" && !realtime) return
    voiceLog("stop", { reason: opts?.reason ?? "stop", phase: state.phase, silent: Boolean(opts?.silent) })
    stopping = true
    starting = false
    speaking = false
    spokenBytes = 0
    speakStartedAt = 0
    playGeneration += 1
    stopIdlePoll()
    lastBusy.clear()
    const session = realtime
    realtime = undefined
    session?.close()
    await audio?.dispose().catch(() => undefined)
    if (!input.audio) audio = undefined
    setState({ phase: "off", realtimeConnected: false, error: undefined })
    stopping = false
    if (!opts?.silent) toast("Vox Code off.")
  }

  const sessionLive = () =>
    state.realtimeConnected ||
    state.phase === "connecting" ||
    state.phase === "listening" ||
    state.phase === "speaking"

  const restartIfLive = async (reason: string) => {
    if (!sessionLive()) return
    await stop({ silent: true, reason })
    await start()
  }

  const displayVoice = (id: string) => voiceMeta(id)?.title ?? id

  return {
    state: () => state,
    model: () => options.model,
    voice: () => options.voice,
    instructions: () => options.instructions,
    chip: () => chipLabel(state),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    stop,
    async toggle() {
      if (starting || stopping) return
      if (state.phase === "off" || state.phase === "error") await start()
      else await stop({ reason: "toggle" })
    },
    async setModel(model) {
      const next = model.trim()
      if (!next || next === CUSTOM_REALTIME_MODEL) return
      if (next === options.model) {
        toast(`Vox Code model is already ${next}.`)
        return
      }
      options = { ...options, model: next }
      input.hooks?.onModelChange?.(next)
      toast(`Vox Code model: ${next}`)
      notify()
      await restartIfLive("model")
    },
    async setVoice(voice) {
      const next = voice.trim()
      if (!next) return
      if (next === options.voice) {
        toast(`${displayVoice(next)} is already the Vox Code speaker.`)
        return
      }
      options = { ...options, voice: next }
      input.hooks?.onVoiceChange?.(next)
      toast(`Vox: ${displayVoice(next)}`)
      notify()
      await restartIfLive("voice")
    },
    async setInstructions(instructions) {
      const trimmed = instructions?.trim() || undefined
      const next =
        trimmed && trimmed !== defaultSpokenInstructions(options.model) ? trimmed : undefined
      if ((options.instructions ?? undefined) === next) {
        toast(next ? "Vox Code prompt unchanged." : "Vox Code prompt is already the default.")
        return
      }
      options = { ...options, instructions: next }
      input.hooks?.onInstructionsChange?.(next)
      toast(next ? "Vox Code prompt saved." : "Vox Code prompt reset to default.")
      notify()
      await restartIfLive("prompt")
    },
    async previewVoice(voice) {
      const next = voice.trim()
      if (!next) return
      const resolvedKey = await (input.resolveKey ??
        (() =>
          resolveOpenAiApiKey({
            pluginKey: options.apiKey,
            directory: directoryOf(),
          })))()
      if (!resolvedKey.key) {
        toast(resolvedKey.hint, "error")
        return
      }
      toast(`Playing ${displayVoice(next)}…`)
      try {
        const pcm = await (input.fetchSpeech ?? fetchVoiceSamplePcm)({
          apiKey: resolvedKey.key,
          voice: next,
        })
        if (input.audio) {
          await input.audio.startPlayback()
          await input.audio.play(pcm)
          await input.audio.drainPlayback()
          return
        }
        await playPcmClip(pcm)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        voiceLog("voice sample failed", message)
        toast(message, "error")
      }
    },
    statusText() {
      const owned = sessions.ownedIds()
      const lines = [
        `phase: ${state.phase}`,
        `realtime: ${state.realtimeConnected ? "connected" : "down"}`,
        `model: ${options.model}`,
        isLiveModel(options.model) ? `backend: ${options.backendModel}` : undefined,
        `voice: ${options.voice}`,
        `prompt: ${options.instructions ? "custom" : "default"}`,
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
