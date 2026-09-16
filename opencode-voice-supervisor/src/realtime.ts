import { Buffer } from "node:buffer"
import WebSocket from "ws"
import { SUPERVISOR_INSTRUCTIONS } from "./instructions.ts"
import { executeTool, parseToolArgs, REALTIME_TOOLS, type FocusHandler } from "./tools.ts"
import type { SessionController } from "./sessions.ts"
import type { VoiceOptions } from "./types.ts"

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
  onAudioDone?: () => void
  onTranscript?: (role: "user" | "assistant", text: string) => void
  onTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

export type RealtimeSession = {
  sendAudio: (pcm: Buffer) => void
  injectText: (text: string, speak?: boolean) => void
  close: () => void
}

type SocketLike = {
  readyState: number
  send: (data: string) => void
  close: () => void
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  addEventListener?: (event: string, listener: (event: { data?: unknown; message?: string }) => void) => void
}

const OPEN = 1

function attach(socket: SocketLike, handlers: { message: (raw: string) => void; close: () => void; error: (err: string) => void }) {
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

export function sessionUpdatePayload(options: Pick<VoiceOptions, "voice" | "instructions">) {
  return {
    type: "session.update",
    session: {
      instructions: options.instructions ?? SUPERVISOR_INSTRUCTIONS,
      voice: options.voice ?? "marin",
      modalities: ["text", "audio"],
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
        interrupt_response: true,
        create_response: true,
      },
      tools: REALTIME_TOOLS,
      tool_choice: "auto",
    },
  }
}

export function createRealtimeSession(
  socket: SocketLike,
  handlers: RealtimeHandlers,
  sessions?: SessionController,
  toolCtx?: { currentSessionId?: string; warnSharedCheckout?: boolean },
  focus?: FocusHandler,
): RealtimeSession {
  const send = (payload: unknown) => {
    if (socket.readyState !== OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const handleToolCall = async (name: string, callId: string, args: Record<string, unknown>) => {
    let output: unknown
    try {
      if (handlers.onTool) {
        output = await handlers.onTool(name, args)
      } else if (sessions) {
        output = (await executeTool(name, args, sessions, toolCtx ?? {}, focus)).output
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
    send({ type: "response.create" })
  }

  attach(socket, {
    message: (raw) => {
      let event: RealtimeEvent
      try {
        event = JSON.parse(raw) as RealtimeEvent
      } catch {
        return
      }
      switch (event.type) {
        case "session.created":
        case "session.updated":
          handlers.onOpen?.()
          break
        case "error": {
          const error = event.error as { message?: string } | undefined
          handlers.onError?.(error?.message ?? "Realtime error")
          break
        }
        case "input_audio_buffer.speech_started":
          handlers.onSpeechStarted?.()
          send({ type: "output_audio_buffer.clear" })
          send({ type: "response.cancel" })
          break
        case "input_audio_buffer.speech_stopped":
          handlers.onSpeechStopped?.()
          break
        case "response.output_audio.delta":
        case "response.audio.delta": {
          const delta = typeof event.delta === "string" ? event.delta : ""
          if (delta) handlers.onAudioDelta?.(Buffer.from(delta, "base64"))
          break
        }
        case "response.output_audio.done":
        case "response.audio.done":
          handlers.onAudioDone?.()
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
          const args = parseToolArgs(typeof event.arguments === "string" ? event.arguments : undefined)
          void handleToolCall(name, callId, args)
          break
        }
        default:
          break
      }
    },
    close: () => handlers.onClose?.("closed"),
    error: (message) => handlers.onError?.(message),
  })

  return {
    sendAudio(pcm) {
      send({
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
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
      if (speak) send({ type: "response.create" })
    },
    close() {
      try {
        socket.close()
      } catch {
        // ignore
      }
    },
  }
}

export async function connectRealtimeSocket(options: { apiKey: string; model: string }): Promise<SocketLike> {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    "OpenAI-Beta": "realtime=v1",
  }

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

export function openRealtime(options: {
  apiKey: string
  model: string
  voice: string
  instructions?: string
  handlers: RealtimeHandlers
  sessions?: SessionController
  toolCtx?: { currentSessionId?: string; warnSharedCheckout?: boolean }
  focus?: FocusHandler
  socket?: SocketLike
}): Promise<RealtimeSession> {
  const start = async () => {
    const socket = options.socket ?? (await connectRealtimeSocket({ apiKey: options.apiKey, model: options.model }))
    const session = createRealtimeSession(socket, options.handlers, options.sessions, options.toolCtx, options.focus)
    const send = (payload: unknown) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(payload))
    }
    const waitOpen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime connection timed out")), 8000)
      const trySend = () => {
        if (socket.readyState === OPEN) {
          send(sessionUpdatePayload({ voice: options.voice, instructions: options.instructions }))
          clearTimeout(timer)
          resolve()
        }
      }
      trySend()
      socket.on?.("open", trySend)
      socket.addEventListener?.("open", () => trySend())
    })
    await waitOpen
    return session
  }
  return start()
}
