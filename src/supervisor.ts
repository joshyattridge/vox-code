import {
  removeVoiceApiKey,
  resolveOpenAiApiKey,
  saveVoiceApiKey,
  validateOpenAiApiKey,
  type ResolvedApiKey,
} from "./auth.ts"
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
import { executeTool, type FocusHandler } from "./tools.ts"
import { setTimeout as delay } from "node:timers/promises"

export type SupervisorHooks = {
  toast?: (input: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  focusSession?: FocusHandler
  currentSessionId?: () => string | undefined
  onModelChange?: (model: string) => void
  onVoiceChange?: (voice: string) => void
  onInstructionsChange?: (instructions?: string) => void
  currentContext?: () => Promise<unknown>
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
  setApiKey: (apiKey: string) => Promise<void>
  removeApiKey: () => Promise<void>
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
  validateKey?: typeof validateOpenAiApiKey
  saveKey?: typeof saveVoiceApiKey
  removeKey?: typeof removeVoiceApiKey
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
  let playbackEndsAt = 0
  let lastAudioPacketAt = 0
  let audioStreamStartedAt = 0
  let audioStreamBytes = 0
  let playbackIdle = new AbortController()
  let playbackWrites: Promise<void> = Promise.resolve()
  let stopping = false
  let idlePoll: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let stableTimer: ReturnType<typeof setTimeout> | undefined
  let policyTimer: ReturnType<typeof setTimeout> | undefined
  let desiredOn = false
  let generation = 0
  let reconnectAttempt = 0
  let sessionStartedAt: number | undefined
  let connectedSince: number | undefined
  let completedActiveMs = 0
  let lastActivityAt: number | undefined
  let costWarningShown = false
  let disposed = false
  let previewing = false
  const lastIdleAt = new Map<string, number>()
  const lastBusy = new Set<string>()

  const notify = () => {
    state = { ...state, model: options.model, voice: options.voice, customInstructions: Boolean(options.instructions) }
    persistVoiceState(state)
    for (const listener of listeners) listener()
  }

  const setState = (patch: Partial<VoiceUiState>) => {
    state = normalizeVoiceState({ ...state, ...patch, ownedSessionIds: sessions.ownedIds() })
    notify()
  }

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    input.hooks?.toast?.({ title: "Voice", message, variant })
  }

  const toolCtx = () => ({
    currentSessionId: input.hooks?.currentSessionId?.(),
    warnSharedCheckout: true,
    directory: directoryOf(),
    currentContext: input.hooks?.currentContext,
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
    const session = realtime
    const now = Date.now()
    if ((lastIdleAt.get(sessionId) ?? 0) + 4000 > now) return
    lastIdleAt.set(sessionId, now)
    try {
      const st = await sessions.status(sessionId)
      if (session !== realtime) return
      if (st.status === "unknown") return
      const result = st.lastMessage?.trim()
      if (result) {
        session.injectText(`Session ${sessionId} finished. ${result}`)
        return
      }
      session.injectText(`Session ${sessionId} is idle with no result yet.`)
    } catch {
      if (session === realtime) session.injectText(`Session ${sessionId} is idle.`)
    }
  }

  const pollOwnedIdle = async () => {
    if (!realtime) return
    for (const id of sessions.ownedIds()) {
      try {
        const st = await sessions.status(id)
        if (st.status === "busy" || st.status === "running" || st.status === "retry") lastBusy.add(id)
        else if (st.status !== "unknown" && lastBusy.delete(id)) handleIdle(id)
      } catch {
        // worker may live in another project; ignore a single poll miss
      }
    }
  }

  const sendMic = (chunk: Buffer) => {
    if (previewing) return
    // Realtime VAD has no echo cancellation on sox. Hold the mic while the
    // assistant is playing so speaker bleed does not barge in on itself.
    if (speaking && !isLiveModel(options.model)) return
    realtime?.sendAudio(chunk)
  }

  const sessionActive = () => Boolean(realtime) && !stopping && state.realtimeConnected
  const activeDurationMs = () => completedActiveMs + (connectedSince ? Date.now() - connectedSince : 0)
  const minutesMs = (minutes: number) => minutes * 60_000

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer) clearTimeout(timer)
  }

  const clearConnectionTimers = () => {
    clearTimer(reconnectTimer)
    clearTimer(stableTimer)
    reconnectTimer = undefined
    stableTimer = undefined
  }

  const syncTimingState = () => {
    setState({
      desiredOn,
      sessionStartedAt,
      connectedSince,
      completedActiveMs,
      lastActivityAt,
      costWarningShown,
    })
  }

  let stop: (opts?: { silent?: boolean; reason?: string; variant?: "info" | "warning" }) => Promise<void>
  let connectAttempt: (reconnecting?: boolean) => Promise<void>

  const schedulePolicies = () => {
    clearTimer(policyTimer)
    policyTimer = undefined
    if (!desiredOn) return
    const now = Date.now()
    const deadlines: number[] = []
    if (options.inactivityTimeoutMinutes > 0 && lastActivityAt) {
      deadlines.push(lastActivityAt + minutesMs(options.inactivityTimeoutMinutes))
    }
    if (connectedSince) {
      if (!costWarningShown && options.costWarningMinutes > 0) {
        deadlines.push(now + Math.max(0, minutesMs(options.costWarningMinutes) - activeDurationMs()))
      }
      if (options.maxSessionDurationMinutes > 0) {
        deadlines.push(now + Math.max(0, minutesMs(options.maxSessionDurationMinutes) - activeDurationMs()))
      }
    }
    if (!deadlines.length) return
    policyTimer = setTimeout(() => {
      policyTimer = undefined
      const current = Date.now()
      if (
        options.inactivityTimeoutMinutes > 0 &&
        lastActivityAt &&
        current - lastActivityAt >= minutesMs(options.inactivityTimeoutMinutes)
      ) {
        void stop({ silent: true, reason: "inactivity", variant: "warning" })
        toast(`Voice stopped after ${options.inactivityTimeoutMinutes} minutes of inactivity.`, "warning")
        return
      }
      if (
        options.maxSessionDurationMinutes > 0 &&
        activeDurationMs() >= minutesMs(options.maxSessionDurationMinutes)
      ) {
        void stop({ silent: true, reason: "maximum duration", variant: "warning" })
        toast(`Voice stopped at the ${options.maxSessionDurationMinutes}-minute session limit.`, "warning")
        return
      }
      if (
        !costWarningShown &&
        options.costWarningMinutes > 0 &&
        activeDurationMs() >= minutesMs(options.costWarningMinutes)
      ) {
        costWarningShown = true
        syncTimingState()
        toast(
          `Voice has been actively connected for ${options.costWarningMinutes} minutes. Realtime audio is billed by OpenAI.`,
          "warning",
        )
      }
      schedulePolicies()
    }, Math.max(0, Math.min(...deadlines) - now))
    policyTimer.unref?.()
  }

  const markActivity = () => {
    lastActivityAt = Date.now()
    syncTimingState()
    schedulePolicies()
  }

  const teardownTransport = async (reason: string) => {
    voiceLog("transport teardown", { reason, phase: state.phase })
    generation += 1
    clearTimer(stableTimer)
    stableTimer = undefined
    starting = false
    speaking = false
    playbackEndsAt = 0
    lastAudioPacketAt = 0
    audioStreamStartedAt = 0
    audioStreamBytes = 0
    playbackIdle.abort()
    playbackWrites = Promise.resolve()
    playGeneration += 1
    stopIdlePoll()
    if (connectedSince) {
      completedActiveMs += Date.now() - connectedSince
      connectedSince = undefined
    }
    const session = realtime
    realtime = undefined
    session?.close()
    await audio?.dispose().catch(() => undefined)
    if (!input.audio) audio = undefined
    setState({ realtimeConnected: false, connectedSince: undefined, completedActiveMs })
  }

  const terminalConnectionError = (message: string) =>
    /(?:api key|authentication|unauthorized|forbidden|\b401\b|\b403\b|model .*not found|invalid .*voice|microphone tools|permission denied)/i.test(
      message,
    )

  const scheduleReconnect = (reason: string) => {
    if (!desiredOn || disposed || !options.autoReconnect || reconnectTimer) return
    reconnectAttempt += 1
    const base = Math.min(1000 * 2 ** (reconnectAttempt - 1), 30_000)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    const reconnectAt = Date.now() + delay
    setState({
      phase: "reconnecting",
      desiredOn: true,
      realtimeConnected: false,
      error: reason,
      reconnectAttempt,
      reconnectAt,
      connectedSince,
      completedActiveMs,
    })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connectAttempt(true)
    }, delay)
    reconnectTimer.unref?.()
  }

  const recoverTransport = async (attemptGeneration: number, reason: string) => {
    if (attemptGeneration !== generation || !desiredOn || stopping || disposed) return
    await teardownTransport(reason)
    if (!options.autoReconnect) {
      desiredOn = false
      setState({ phase: "error", desiredOn: false, realtimeConnected: false, error: reason })
      toast(`Voice disconnected: ${reason}`, "error")
      return
    }
    toast("Voice disconnected. Reconnecting…", "warning")
    scheduleReconnect(reason)
  }

  connectAttempt = async (reconnecting = false) => {
    if (starting || stopping || disposed || !desiredOn || state.realtimeConnected) return
    starting = true
    const attemptGeneration = ++generation
    try {
      const resolvedKey = await (input.resolveKey ??
        (() =>
          resolveOpenAiApiKey({
            pluginKey: options.apiKey,
            directory: directoryOf(),
          })))()
      if (attemptGeneration !== generation || !desiredOn) return
      if (!resolvedKey.key) {
        desiredOn = false
        starting = false
        clearTimer(policyTimer)
        setState({ phase: "error", desiredOn: false, error: resolvedKey.hint, realtimeConnected: false })
        toast(resolvedKey.hint, "error")
        return
      }
      keySource = resolvedKey.source
      setState({
        phase: reconnecting ? "reconnecting" : "connecting",
        desiredOn: true,
        error: undefined,
        reconnectAttempt: reconnectAttempt || undefined,
      })
      audio = audio ?? detectAudio()
      audio.setErrorHandler?.((error) => {
        void recoverTransport(attemptGeneration, error.message)
      })
      await audio.startPlayback()
      if (attemptGeneration !== generation || !desiredOn) return
      voiceLog("audio io", audio.name)
      const connect = input.connect ?? ((opts) => (isLiveModel(opts.model) ? openLive(opts) : openRealtime(opts)))
      const session = await connect({
        apiKey: resolvedKey.key,
        model: options.model,
        voice: options.voice,
        instructions: options.instructions,
        backendModel: options.backendModel,
        sessions,
        toolCtx,
        focus: input.hooks?.focusSession,
        handlers: {
          onTool: async (name, args) => {
            if (attemptGeneration !== generation || !desiredOn) throw new Error("Voice session is no longer active")
            const result = await executeTool(name, args, sessions, toolCtx(), input.hooks?.focusSession)
            if (attemptGeneration === generation) setState({})
            return result.output
          },
          onOpen: () => {
            if (attemptGeneration !== generation || !desiredOn) return
            voiceLog("connected", options.model)
          },
          onClose: (reason) => {
            voiceLog("socket closed", { phase: state.phase, stopping, reason })
            void recoverTransport(attemptGeneration, reason || "socket closed")
          },
          onError: (message) => {
            voiceLog("error", message)
            if (attemptGeneration !== generation || stopping || isBenignVoiceError(message)) return
            if (terminalConnectionError(message)) {
              desiredOn = false
              void teardownTransport("terminal error").then(() => {
                setState({ phase: "error", desiredOn: false, error: message, realtimeConnected: false })
                toast(message, "error")
              })
              return
            }
            void recoverTransport(attemptGeneration, message)
          },
          onSpeechStarted: () => {
            if (attemptGeneration !== generation || !sessionActive()) return
            markActivity()
            voiceLog("heard speech", { speaking, phase: state.phase, model: options.model })
            if (speaking && !isLiveModel(options.model)) return
            setState({ phase: "listening" })
          },
          onSpeechStopped: () => {
            if (attemptGeneration !== generation || !sessionActive() || speaking) return
            setState({ phase: "connected" })
          },
          onAudioDelta: (pcm) => {
            if (attemptGeneration !== generation || !sessionActive() || !pcm.length) return
            // Every packet invalidates an older drain, including packets arriving
            // during the echo hold or after a Live stream's idle heuristic.
            playGeneration += 1
            playbackIdle.abort()
            playbackIdle = new AbortController()
            speaking = true
            const now = Date.now()
            const gapMs = lastAudioPacketAt ? now - lastAudioPacketAt : 0
            const queuedMs = Math.max(0, playbackEndsAt - now)
            if (lastAudioPacketAt && !queuedMs) {
              voiceLog("audio buffer depleted", { gapMs, packetMs: playbackMs(pcm.length) })
            } else if (gapMs > 300) {
              voiceLog("audio delivery gap", { gapMs, queuedMs, packetMs: playbackMs(pcm.length) })
            }
            lastAudioPacketAt = now
            if (!audioStreamStartedAt) audioStreamStartedAt = now
            audioStreamBytes += pcm.length
            playbackEndsAt = Math.max(now, playbackEndsAt) + playbackMs(pcm.length)
            if (state.phase !== "speaking") setState({ phase: "speaking", realtimeConnected: true })
            const output = audio
            playbackWrites = playbackWrites.then(async () => {
              if (attemptGeneration === generation && sessionActive()) await output?.play(pcm)
            }).catch((error) => recoverTransport(attemptGeneration, error instanceof Error ? error.message : String(error)))
          },
          onAudioDone: async () => {
            if (attemptGeneration !== generation || !sessionActive() || !speaking) return
            if (audioStreamStartedAt) {
              voiceLog("audio stream pacing", {
                elapsedMs: Date.now() - audioStreamStartedAt,
                audioMs: playbackMs(audioStreamBytes),
              })
              audioStreamStartedAt = 0
              audioStreamBytes = 0
            }
            const playbackGeneration = playGeneration
            const signal = playbackIdle.signal
            const output = audio
            try {
              await playbackWrites
              if (signal.aborted) return
              await delay(Math.max(0, playbackEndsAt - Date.now()), undefined, { signal })
              await output?.drainPlayback(!isLiveModel(options.model))
              await delay(ECHO_HOLD_MS, undefined, { signal })
            } catch (error) {
              if (!signal.aborted) await recoverTransport(attemptGeneration, error instanceof Error ? error.message : String(error))
              return
            }
            if (
              attemptGeneration !== generation ||
              playbackGeneration !== playGeneration ||
              !sessionActive()
            ) return
            speaking = false
            playbackEndsAt = 0
            lastAudioPacketAt = 0
            if (state.realtimeConnected) setState({ phase: "connected" })
          },
          onTranscript: (role, text) => {
            if (attemptGeneration !== generation) return
            if (role === "user") {
              markActivity()
              setState({ lastUserTranscript: text })
            } else setState({ lastAssistantTranscript: text })
          },
        },
      })
      if (attemptGeneration !== generation || !desiredOn) {
        session.close()
        return
      }
      realtime = session
      await audio.startCapture(sendMic)
      if (attemptGeneration !== generation || !desiredOn) return
      if (!connectedSince) connectedSince = Date.now()
      setState({
        phase: "connected",
        desiredOn: true,
        realtimeConnected: true,
        connectedSince,
        completedActiveMs,
        error: undefined,
        reconnectAt: undefined,
      })
      stopIdlePoll()
      idlePoll = setInterval(() => void pollOwnedIdle(), 2500)
      stableTimer = setTimeout(() => {
        reconnectAttempt = 0
        setState({ reconnectAttempt: undefined, reconnectAt: undefined })
      }, 30_000)
      stableTimer.unref?.()
      if (reconnecting) toast("Voice reconnected.", "success")
      else toast("Voice connected.", "success")
      schedulePolicies()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attemptGeneration !== generation || !desiredOn) return
      await teardownTransport("connect failed")
      if (terminalConnectionError(message) || !options.autoReconnect) {
        desiredOn = false
        setState({ phase: "error", desiredOn: false, error: message, realtimeConnected: false })
        toast(message, "error")
      } else {
        scheduleReconnect(message)
      }
    } finally {
      if (attemptGeneration === generation) starting = false
    }
  }

  const start = async () => {
    if (desiredOn || stopping || disposed) return
    desiredOn = true
    sessionStartedAt = Date.now()
    lastActivityAt = sessionStartedAt
    completedActiveMs = 0
    connectedSince = undefined
    costWarningShown = false
    reconnectAttempt = 0
    syncTimingState()
    schedulePolicies()
    await connectAttempt(false)
  }

  stop = async (opts) => {
    if (stopping && state.phase === "off" && !realtime) return
    voiceLog("stop", { reason: opts?.reason ?? "stop", phase: state.phase, silent: Boolean(opts?.silent) })
    stopping = true
    desiredOn = false
    clearConnectionTimers()
    clearTimer(policyTimer)
    policyTimer = undefined
    await teardownTransport(opts?.reason ?? "stop")
    lastBusy.clear()
    reconnectAttempt = 0
    sessionStartedAt = undefined
    lastActivityAt = undefined
    setState({
      phase: "off",
      desiredOn: false,
      realtimeConnected: false,
      error: undefined,
      reconnectAttempt: undefined,
      reconnectAt: undefined,
      sessionStartedAt: undefined,
      connectedSince: undefined,
      completedActiveMs,
      lastActivityAt: undefined,
    })
    stopping = false
    if (!opts?.silent) toast("Voice off.", opts?.variant ?? "info")
  }

  const restartIfLive = async (reason: string) => {
    if (!desiredOn) return
    clearConnectionTimers()
    await teardownTransport(reason)
    await connectAttempt(false)
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
      if (desiredOn) await stop({ reason: "toggle" })
      else await start()
    },
    async setModel(model) {
      const next = model.trim()
      if (!next || next === CUSTOM_REALTIME_MODEL) return
      if (next === options.model) {
        toast(`Voice model is already ${next}.`)
        return
      }
      options = { ...options, model: next }
      input.hooks?.onModelChange?.(next)
      toast(`Voice model: ${next}`)
      notify()
      await restartIfLive("model")
    },
    async setVoice(voice) {
      const next = voice.trim()
      if (!next) return
      if (next === options.voice) {
        toast(`${displayVoice(next)} is already the Voice speaker.`)
        return
      }
      options = { ...options, voice: next }
      input.hooks?.onVoiceChange?.(next)
      toast(`Voice: ${displayVoice(next)}`)
      notify()
      await restartIfLive("voice")
    },
    async setInstructions(instructions) {
      const trimmed = instructions?.trim() || undefined
      const next =
        trimmed && trimmed !== defaultSpokenInstructions(options.model) ? trimmed : undefined
      if ((options.instructions ?? undefined) === next) {
        toast(next ? "Voice prompt unchanged." : "Voice prompt is already the default.")
        return
      }
      options = { ...options, instructions: next }
      input.hooks?.onInstructionsChange?.(next)
      toast(next ? "Voice prompt saved." : "Voice prompt reset to default.")
      notify()
      await restartIfLive("prompt")
    },
    async setApiKey(apiKey) {
      try {
        await (input.validateKey ?? validateOpenAiApiKey)(apiKey)
        keySource = (input.saveKey ?? saveVoiceApiKey)(apiKey)
        toast(`Voice API key validated and saved in ${keySource === "keychain" ? "the OS keychain" : "a private file"}.`, "success")
        await restartIfLive("api key")
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
      }
    },
    async removeApiKey() {
      const removed = (input.removeKey ?? removeVoiceApiKey)()
      keySource = "missing"
      if (desiredOn) await stop({ silent: true, reason: "API key removed" })
      toast(removed ? "Voice API key removed." : "No saved Voice API key was found.", removed ? "success" : "info")
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
      previewing = true
      try {
        const pcm = await (input.fetchSpeech ?? fetchVoiceSamplePcm)({
          apiKey: resolvedKey.key,
          voice: next,
        })
        if (input.audio) {
          await input.audio.startPlayback()
          await input.audio.play(pcm)
          await input.audio.drainPlayback(true)
          return
        }
        await playPcmClip(pcm)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        voiceLog("voice sample failed", message)
        toast(message, "error")
      } finally {
        await delay(ECHO_HOLD_MS)
        previewing = false
      }
    },
    statusText() {
      const owned = sessions.ownedIds()
      const formatDuration = (milliseconds: number) => {
        const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
        const hours = Math.floor(totalSeconds / 3600)
        const minutes = Math.floor((totalSeconds % 3600) / 60)
        const seconds = totalSeconds % 60
        return hours ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`
      }
      const lines = [
        `phase: ${state.phase}`,
        `desired: ${desiredOn ? "on" : "off"}`,
        `realtime: ${state.realtimeConnected ? "connected" : "down"}`,
        sessionStartedAt ? `active: ${formatDuration(activeDurationMs())}` : undefined,
        lastActivityAt ? `inactive: ${formatDuration(Date.now() - lastActivityAt)}` : undefined,
        state.phase === "reconnecting" ? `reconnect attempt: ${reconnectAttempt}` : undefined,
        state.reconnectAt ? `retry in: ${Math.max(0, Math.ceil((state.reconnectAt - Date.now()) / 1000))}s` : undefined,
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
      if (!realtime || !sessions.ownedIds().includes(sessionId)) return
      realtime.injectText(`Session ${sessionId} error: ${message}.`)
    },
    handlePermission(sessionId, permissionId, title) {
      if (!realtime || !sessions.ownedIds().includes(sessionId)) return
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
      disposed = true
      speaking = false
      stopIdlePoll()
      await stop({ reason: "dispose" })
      listeners.clear()
    },
  }
}
