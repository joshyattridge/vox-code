import { Buffer } from "node:buffer"
import WebSocket from "ws"
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
const AUDIO_GAP_MS = 40

function attach(
  socket: SocketLike,
  handlers: { message: (raw: string) => void; close: () => void; error: (err: string) => void },
) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener("message", (event) => {
      const data = event.data
      handlers.message(typeof data === "string" ? data : String(data))
    })
    socket.addEventListener("close", () => handlers.close())
    socket.addEventListener("error", (event) => handlers.error(event.message ?? "WebSocket error"))
    return
  }
  socket.on?.("message", (data: unknown) => {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data)
    handlers.message(text)
  })
  socket.on?.("close", () => handlers.close())
  socket.on?.("error", (error: unknown) => {
    handlers.error(error instanceof Error ? error.message : String(error))
  })
}

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
  const pendingToolCalls = new Set<string>()

  const send = (payload: unknown) => {
    if (socket.readyState !== OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const noteAudioDelta = () => {
    if (audioGap) clearTimeout(audioGap)
    audioGap = setTimeout(() => {
      audioGap = undefined
      void handlers.onAudioDone?.()
    }, AUDIO_GAP_MS)
    audioGap.unref?.()
  }

  const handleToolCall = async (name: string, callId: string, args: Record<string, unknown>) => {
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
    if (pendingToolCalls.size === 0) {
      toolSeq += 1
      send({ type: "response.create", event_id: `continue_${toolSeq}` })
    }
  }

  attach(socket, {
    message: (raw) => {
      let event: LiveEvent
      try {
        event = JSON.parse(raw) as LiveEvent
      } catch {
        return
      }
      switch (event.type) {
        case "session.started":
          handlers.onOpen?.()
          break
        case "session.updated":
          break
        case "session.closed":
          voiceLog("live session.closed", event)
          handlers.onClose?.("session.closed")
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
          userTranscript += delta
          handlers.onSpeechStarted?.()
          handlers.onTranscript?.("user", userTranscript)
          break
        }
        case "session.output_transcript.delta": {
          const delta = typeof event.delta === "string" ? event.delta : ""
          if (!delta) break
          assistantTranscript += delta
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
          if (inner?.type !== "response.output_item.done") break
          const item = inner.item as
            | { type?: string; call_id?: string; name?: string; arguments?: string }
            | undefined
          if (item?.type !== "function_call" || !item.name || !item.call_id) break
          const args = parseToolArgs(item.arguments)
          void handleToolCall(item.name, item.call_id, args)
          break
        }
        default:
          if (typeof event.type === "string" && !event.type.includes("audio") && !event.type.includes("transcript")) {
            voiceLog("live event", event.type)
          }
          break
      }
    },
    close: () => {
      if (audioGap) clearTimeout(audioGap)
      handlers.onClose?.("closed")
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
    injectText(text) {
      commentSeq += 1
      send({
        type: "session.commentary.append",
        event_id: `comment_${commentSeq}`,
        delegation_id: null,
        content: text.slice(0, 2000),
      })
    },
    close() {
      if (audioGap) clearTimeout(audioGap)
      send({ type: "session.close" })
      try {
        socket.close()
      } catch {
        // ignore
      }
    },
  }
}

export async function connectLiveSocket(options: { apiKey: string }): Promise<SocketLike> {
  const { url, headers } = liveConnectConfig(options)

  const globalWs = (globalThis as { WebSocket?: new (url: string, extra?: unknown) => SocketLike }).WebSocket
  if (globalWs && process.versions.bun) {
    return new globalWs(url, { headers } as never)
  }

  const socket = new WebSocket(url, { headers })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", (error) => reject(error))
  })
  return socket as unknown as SocketLike
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
    const send = (payload: unknown) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(payload))
    }
    const waitStarted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Live connection timed out")), 8000)
      const trySend = () => {
        if (socket.readyState === OPEN) {
          send(
            sessionStartPayload({
              model: options.model,
              voice: options.voice,
              instructions: options.instructions,
              backendModel: options.backendModel,
            }),
          )
        }
      }
      const onMessage = (raw: unknown) => {
        const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)
        let event: LiveEvent
        try {
          event = JSON.parse(text) as LiveEvent
        } catch {
          return
        }
        if (event.type === "session.started") {
          clearTimeout(timer)
          resolve()
        }
        if (event.type === "error") {
          const error = event.error as { message?: string } | undefined
          clearTimeout(timer)
          reject(new Error(error?.message ?? "Live error"))
        }
      }
      socket.on?.("message", onMessage)
      socket.addEventListener?.("message", (event) => onMessage(event.data))
      trySend()
      socket.on?.("open", trySend)
      socket.addEventListener?.("open", () => trySend())
    })
    await waitStarted
    return session
  }
  return start()
}
