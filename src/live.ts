import { Buffer } from "node:buffer"
import { attachSocket as attach, handshake, openSocket } from "./socket.ts"
import { LIVE_BACKEND_INSTRUCTIONS, resolveSpokenInstructions } from "./instructions.ts"
import { voiceLog } from "./log.ts"
import type { RealtimeHandlers, RealtimeSession, SocketLike } from "./realtime.ts"
import type { SessionController } from "./sessions.ts"
import { executeTool, parseToolArgs, REALTIME_TOOLS, resolveToolContext, type FocusHandler, type ToolContextInput } from "./tools.ts"
import { pcmRms } from "./audio.ts"
import { DEFAULT_BACKEND_MODEL, DEFAULT_VOICE, SAMPLE_RATE, type VoiceOptions } from "./types.ts"

type LiveEvent = {
  type: string
  [key: string]: unknown
}

const OPEN = 1
// Live has no audio-done event. This is only a playback-idle heuristic.
const AUDIO_GAP_MS = 250
const TRANSCRIPT_CHARS = 4000

export function liveConnectConfig(options: { apiKey: string }) {
  return {
    url: "wss://api.openai.com/v1/live/sessions",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
  }
}

export function sessionStartPayload(
  options: Pick<VoiceOptions, "model" | "voice" | "instructions" | "backendModel">,
) {
  return {
    type: "session.start",
    event_id: "event_start",
    session: {
      model: options.model ?? "gpt-live-1",
      instructions: resolveSpokenInstructions(options.model, options.instructions),
      audio: {
        format: { type: "audio/pcm", rate: SAMPLE_RATE },
        output: { voice: options.voice ?? DEFAULT_VOICE },
      },
      delegation: {
        type: "responses",
        responses: {
          model: options.backendModel ?? DEFAULT_BACKEND_MODEL,
          instructions: LIVE_BACKEND_INSTRUCTIONS,
          tools: REALTIME_TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: true,
          max_output_tokens: 600,
          reasoning: { effort: "low" },
        },
      },
    },
  }
}

export function createLiveSession(
  socket: SocketLike,
  handlers: RealtimeHandlers,
  sessions?: SessionController,
  toolCtx?: ToolContextInput,
  focus?: FocusHandler,
): RealtimeSession {
  let pendingByte = Buffer.alloc(0)
  let audioGap: ReturnType<typeof setTimeout> | undefined
  let userTranscript = ""
  let assistantTranscript = ""
  let commentSeq = 0
  let toolSeq = 0
  let loggedAudio = false
  let closed = false
  let closing = false
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let opened = false
  let continuationNeeded = false
  const activeResponses = new Set<string>()
  const seenToolCalls = new Set<string>()
  const pendingToolCalls = new Set<string>()

  const send = (payload: unknown) => {
    if (closed || closing || socket.readyState !== OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const noteAudioDelta = () => {
    if (audioGap) clearTimeout(audioGap)
    audioGap = setTimeout(() => {
      audioGap = undefined
      void Promise.resolve(handlers.onAudioDone?.()).catch((error) => handlers.onError?.(String(error)))
    }, AUDIO_GAP_MS)
    audioGap.unref?.()
  }

  const continueResponse = () => {
    if (closed || closing || !continuationNeeded || activeResponses.size || pendingToolCalls.size) return
    continuationNeeded = false
    toolSeq += 1
    send({ type: "response.create", event_id: `continue_${toolSeq}` })
  }

  const handleToolCall = async (name: string, callId: string, args: Record<string, unknown>) => {
    if (closed || closing || seenToolCalls.has(callId)) return
    seenToolCalls.add(callId)
    pendingToolCalls.add(callId)
    let output: unknown
    try {
      if (handlers.onTool) {
        output = await handlers.onTool(name, args)
      } else if (sessions) {
        output = (await executeTool(name, args, sessions, resolveToolContext(toolCtx), focus)).output
      } else {
        throw new Error("No tool host configured")
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : String(error) }
    }
    toolSeq += 1
    send({
      type: "response.item.create",
      event_id: `tool_result_${toolSeq}`,
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
    pendingToolCalls.delete(callId)
    continuationNeeded = true
    continueResponse()
  }

  attach(socket, {
    message: (raw) => {
      if (closed) return
      let event: LiveEvent
      try {
        event = JSON.parse(raw) as LiveEvent
      } catch {
        return
      }
      if (closing && event.type !== "session.closed") return
      try {
      switch (event.type) {
        case "session.started":
          if (!opened) {
            opened = true
            handlers.onOpen?.()
          }
          break
        case "session.updated":
          break
        case "session.closed":
          closed = true
          if (closeTimer) clearTimeout(closeTimer)
          if (audioGap) clearTimeout(audioGap)
          voiceLog("live session.closed", event)
          socket.close()
          if (!closing) handlers.onClose?.("session.closed")
          break
        case "error": {
          const error = event.error as { message?: string; code?: string } | undefined
          const message = error?.message ?? "Live error"
          voiceLog("live error", error ?? event)
          handlers.onError?.(message)
          break
        }
        case "session.input_transcript.delta": {
          const delta = typeof event.delta === "string" ? event.delta : ""
          if (!delta) break
          userTranscript = (userTranscript + delta).slice(-TRANSCRIPT_CHARS)
          handlers.onSpeechStarted?.()
          handlers.onTranscript?.("user", userTranscript)
          break
        }
        case "session.output_transcript.delta": {
          const delta = typeof event.delta === "string" ? event.delta : ""
          if (!delta) break
          assistantTranscript = (assistantTranscript + delta).slice(-TRANSCRIPT_CHARS)
          handlers.onTranscript?.("assistant", assistantTranscript)
          break
        }
        case "session.output_audio.delta": {
          const delta =
            typeof event.delta === "string"
              ? event.delta
              : typeof event.audio === "string"
                ? event.audio
                : ""
          if (delta) {
            const pcm = Buffer.from(delta, "base64")
            if (!loggedAudio) {
              loggedAudio = true
              voiceLog("output audio stream", { bytes: pcm.length, rms: Math.round(pcmRms(pcm)) })
            }
            handlers.onAudioDelta?.(pcm)
            noteAudioDelta()
          }
          break
        }
        case "response.event": {
          const inner = event.event as LiveEvent | undefined
          const responseKey = typeof event.delegation_id === "string" ? event.delegation_id : "default"
          if (inner?.type === "response.created") {
            activeResponses.add(responseKey)
            break
          }
          if (inner && ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(inner.type)) {
            activeResponses.delete(responseKey)
            continueResponse()
            break
          }
          if (inner?.type !== "response.output_item.done") break
          const item = inner.item as
            | { type?: string; call_id?: string; name?: string; arguments?: string }
            | undefined
          if (item?.type !== "function_call" || !item.name || !item.call_id) break
          if (seenToolCalls.has(item.call_id)) break
          activeResponses.add(responseKey)
          const args = parseToolArgs(item.arguments)
          void handleToolCall(item.name, item.call_id, args).catch((error) => handlers.onError?.(String(error)))
          break
        }
        default:
          if (typeof event.type === "string" && !event.type.includes("audio") && !event.type.includes("transcript")) {
            voiceLog("live event", event.type)
          }
          break
      }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        voiceLog("live event failed", { type: event.type, message })
        handlers.onError?.(message)
      }
    },
    close: () => {
      if (closed) return
      closed = true
      if (closeTimer) clearTimeout(closeTimer)
      if (audioGap) clearTimeout(audioGap)
      if (!closing) handlers.onClose?.("closed")
    },
    error: (message) => handlers.onError?.(message),
  })

  return {
    sendAudio(pcm) {
      const bytes = Buffer.concat([pendingByte, pcm])
      const completeLength = bytes.length - (bytes.length % 2)
      pendingByte = bytes.subarray(completeLength)
      if (!completeLength) return
      send({
        type: "session.input_audio.append",
        audio: bytes.subarray(0, completeLength).toString("base64"),
      })
    },
    injectText(text, speak = true) {
      commentSeq += 1
      send({
        type: speak ? "session.commentary.append" : "session.thinking.append",
        event_id: `comment_${commentSeq}`,
        delegation_id: null,
        content: text.slice(0, 2000),
      })
    },
    close() {
      if (closed || closing) return
      if (audioGap) clearTimeout(audioGap)
      if (!opened) {
        closed = true
        socket.close()
        return
      }
      send({ type: "session.close" })
      closing = true
      // Allow final usage/session.closed to drain before releasing the socket.
      closeTimer = setTimeout(() => {
        closed = true
        socket.close()
      }, 1000)
      closeTimer.unref?.()
    },
  }
}

export async function connectLiveSocket(options: { apiKey: string }): Promise<SocketLike> {
  const { url, headers } = liveConnectConfig(options)
  return openSocket(url, headers)
}

export function openLive(options: {
  apiKey: string
  model: string
  voice: string
  instructions?: string
  backendModel?: string
  handlers: RealtimeHandlers
  sessions?: SessionController
  toolCtx?: ToolContextInput
  focus?: FocusHandler
  socket?: SocketLike
}): Promise<RealtimeSession> {
  const start = async () => {
    const socket = options.socket ?? (await connectLiveSocket({ apiKey: options.apiKey }))
    const session = createLiveSession(socket, options.handlers, options.sessions, options.toolCtx, options.focus)
    try {
      await handshake(socket, sessionStartPayload(options), "session.started", "Live")
      return session
    } catch (error) {
      session.close()
      throw error
    }
  }
  return start()
}
