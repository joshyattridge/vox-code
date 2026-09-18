import { Buffer } from "node:buffer"
import { attachSocket as attach, handshake, openSocket, type SocketLike } from "./socket.ts"
export type { SocketLike } from "./socket.ts"
import { resolveSpokenInstructions } from "./instructions.ts"
import { voiceLog } from "./log.ts"
import { executeTool, parseToolArgs, REALTIME_TOOLS, resolveToolContext, type FocusHandler, type ToolContextInput } from "./tools.ts"
import type { SessionController } from "./sessions.ts"
import { DEFAULT_MODEL, DEFAULT_VOICE, SAMPLE_RATE, type VoiceOptions } from "./types.ts"

export type RealtimeEvent = {
  type: string
  [key: string]: unknown
}

export type RealtimeHandlers = {
  onOpen?: () => void
  onClose?: (reason: string) => void
  onError?: (message: string) => void
  onSpeechStarted?: () => void
  onSpeechStopped?: () => void
  onAudioDelta?: (pcm: Buffer) => void
  onAudioDone?: () => void | Promise<void>
  onTranscript?: (role: "user" | "assistant", text: string) => void
  onTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

export type RealtimeSession = {
  sendAudio: (pcm: Buffer) => void
  injectText: (text: string, speak?: boolean) => void
  close: () => void
}

const OPEN = 1

function isBenignRealtimeError(message: string) {
  const text = message.toLowerCase()
  return (
    text.includes("cancellation failed") ||
    text.includes("no active response") ||
    text.includes("output_audio_buffer")
  )
}

function isActiveResponseError(error: { message?: string; code?: string } | undefined) {
  return (
    error?.code === "conversation_already_has_active_response" ||
    error?.message?.toLowerCase().includes("conversation already has an active response") === true
  )
}

export function realtimeConnectConfig(options: { apiKey: string; model: string }) {
  return {
    url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
  }
}

export function sessionUpdatePayload(options: Pick<VoiceOptions, "model" | "voice" | "instructions">) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: options.model ?? DEFAULT_MODEL,
      instructions: resolveSpokenInstructions(options.model, options.instructions),
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "high",
            interrupt_response: false,
            create_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          voice: options.voice ?? DEFAULT_VOICE,
        },
      },
      tools: REALTIME_TOOLS,
      tool_choice: "auto",
    },
  }
}

export function pcmEndMs(bytes: number, startedAt: number, now = Date.now()) {
  const generatedMs = Math.ceil((bytes / 2 / SAMPLE_RATE) * 1000)
  if (generatedMs <= 0) return 0
  return Math.max(0, Math.min(now - startedAt, generatedMs))
}

export function createRealtimeSession(
  socket: SocketLike,
  handlers: RealtimeHandlers,
  sessions?: SessionController,
  toolCtx?: ToolContextInput,
  focus?: FocusHandler,
): RealtimeSession {
  let closed = false
  const send = (payload: unknown) => {
    if (closed || socket.readyState !== OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const seenCalls = new Set<string>()
  const pendingCalls = new Set<string>()
  let responseActive = false
  let responseRequested = false
  let opened = false
  const flushResponse = () => {
    if (closed || responseActive || pendingCalls.size || !responseRequested) return
    responseRequested = false
    responseActive = true
    send({ type: "response.create" })
  }
  const requestResponse = () => {
    responseRequested = true
    flushResponse()
  }
  let pendingByte = Buffer.alloc(0)
  let currentItemId: string | undefined
  let generatedBytes = 0
  let playbackStartedAt = 0
  let clearedForItem: string | undefined

  const noteAudioItem = (event: RealtimeEvent) => {
    const item = event.item as { id?: string } | undefined
    const itemId = typeof event.item_id === "string" ? event.item_id : item?.id
    if (!itemId) return
    if (itemId === currentItemId) return
    currentItemId = itemId
    generatedBytes = 0
    playbackStartedAt = 0
  }

  const clearInputBuffer = () => {
    if (!currentItemId || clearedForItem === currentItemId) return
    clearedForItem = currentItemId
    send({ type: "input_audio_buffer.clear" })
  }

  const handleToolCall = async (name: string, callId: string, args: Record<string, unknown>) => {
    if (closed || !name || !callId || seenCalls.has(callId)) return
    seenCalls.add(callId)
    pendingCalls.add(callId)
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
    send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
    pendingCalls.delete(callId)
    requestResponse()
  }

  attach(socket, {
    message: (raw) => {
      if (closed) return
      let event: RealtimeEvent
      try {
        event = JSON.parse(raw) as RealtimeEvent
      } catch {
        return
      }
      try {
      switch (event.type) {
        case "session.updated":
          if (!opened) {
            opened = true
            handlers.onOpen?.()
          }
          break
        case "response.created":
          responseActive = true
          break
        case "response.done": {
          const response = event.response as { status?: string; status_details?: { error?: { message?: string } }; output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }> } | undefined
          // The terminal snapshot is also a valid source of completed calls.
          for (const item of response?.output ?? []) {
            if (item.type === "function_call" && item.name && item.call_id) {
              void handleToolCall(item.name, item.call_id, parseToolArgs(item.arguments)).catch((error) => handlers.onError?.(String(error)))
            }
          }
          responseActive = false
          if (response?.status === "failed") {
            handlers.onError?.(response.status_details?.error?.message ?? "Realtime response failed")
          } else flushResponse()
          break
        }
        case "error": {
          const error = event.error as { message?: string; code?: string } | undefined
          const message = error?.message ?? "Realtime error"
          if (isActiveResponseError(error)) {
            // VAD may start a response while a client response.create is in flight.
            // Keep the added context and retry after the active response finishes.
            responseActive = true
            responseRequested = true
            break
          }
          if (isBenignRealtimeError(message)) break
          handlers.onError?.(message)
          break
        }
        case "input_audio_buffer.speech_started":
          voiceLog("speech started", { speaking: Boolean(generatedBytes), item: currentItemId })
          handlers.onSpeechStarted?.()
          break
        case "input_audio_buffer.speech_stopped":
          handlers.onSpeechStopped?.()
          break
        case "response.output_item.added":
          noteAudioItem(event)
          break
        case "response.output_audio.delta":
        case "response.audio.delta": {
          noteAudioItem(event)
          const delta = typeof event.delta === "string" ? event.delta : ""
          if (!delta) break
          const pcm = Buffer.from(delta, "base64")
          generatedBytes += pcm.length
          if (!playbackStartedAt) playbackStartedAt = Date.now()
          clearInputBuffer()
          handlers.onAudioDelta?.(pcm)
          break
        }
        case "response.output_audio.done":
        case "response.audio.done":
          void Promise.resolve(handlers.onAudioDone?.()).catch((error) => handlers.onError?.(String(error)))
          break
        case "conversation.item.input_audio_transcription.completed": {
          const transcript = typeof event.transcript === "string" ? event.transcript : ""
          if (transcript) handlers.onTranscript?.("user", transcript)
          break
        }
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
          break
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          const transcript = typeof event.transcript === "string" ? event.transcript : ""
          if (transcript) handlers.onTranscript?.("assistant", transcript)
          break
        }
        case "response.function_call_arguments.done": {
          const name = String(event.name ?? "")
          const callId = String(event.call_id ?? "")
          if (seenCalls.has(callId)) break
          responseActive = true
          const args = parseToolArgs(typeof event.arguments === "string" ? event.arguments : undefined)
          void handleToolCall(name, callId, args).catch((error) => handlers.onError?.(String(error)))
          break
        }
        case "response.output_item.done": {
          const item = event.item as
            | { type?: string; call_id?: string; name?: string; arguments?: string }
            | undefined
          if (item?.type !== "function_call" || !item.name || !item.call_id) break
          if (seenCalls.has(item.call_id)) break
          responseActive = true
          void handleToolCall(item.name, item.call_id, parseToolArgs(item.arguments)).catch((error) => handlers.onError?.(String(error)))
          break
        }
        default:
          break
      }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        voiceLog("realtime event failed", { type: event.type, message })
        handlers.onError?.(message)
      }
    },
    close: () => {
      if (closed) return
      closed = true
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
        type: "input_audio_buffer.append",
        audio: bytes.subarray(0, completeLength).toString("base64"),
      })
    },
    injectText(text, speak = true) {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      })
      if (speak) requestResponse()
    },
    close() {
      closed = true
      try {
        socket.close()
      } catch {
        // ignore
      }
    },
  }
}

export async function connectRealtimeSocket(options: { apiKey: string; model: string }): Promise<SocketLike> {
  const { url, headers } = realtimeConnectConfig(options)
  return openSocket(url, headers)
}

export function openRealtime(options: {
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
    const socket = options.socket ?? (await connectRealtimeSocket({ apiKey: options.apiKey, model: options.model }))
    const session = createRealtimeSession(socket, options.handlers, options.sessions, options.toolCtx, options.focus)
    try {
      await handshake(socket, sessionUpdatePayload(options), "session.updated", "Realtime")
      return session
    } catch (error) {
      session.close()
      throw error
    }
  }
  return start()
}
