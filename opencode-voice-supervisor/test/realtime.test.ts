import assert from "node:assert/strict"
import { test } from "node:test"
import { Buffer } from "node:buffer"
import { createRealtimeSession, realtimeConnectConfig, sessionUpdatePayload } from "../src/realtime.ts"

class FakeSocket {
  readyState = 1
  sent: unknown[] = []
  messageHandler?: (raw: string) => void
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
  on(event: string, listener: (raw: string) => void) {
    if (event === "message") this.messageHandler = listener
  }
  emit(payload: unknown) {
    this.messageHandler?.(JSON.stringify(payload))
  }
}

test("session update uses the GA realtime shape", () => {
  const payload = sessionUpdatePayload({ voice: "cedar", model: "gpt-realtime" })
  assert.equal(payload.session.type, "realtime")
  assert.equal(payload.session.model, "gpt-realtime")
  assert.deepEqual(payload.session.output_modalities, ["audio"])
  assert.equal(payload.session.audio.output.voice, "cedar")
  assert.equal(payload.session.audio.input.format.type, "audio/pcm")
  assert.equal(payload.session.audio.input.turn_detection.type, "semantic_vad")
  const names = payload.session.tools.map((tool) => tool.name)
  assert.ok(names.includes("create_session"))
  assert.ok(names.includes("prompt_session"))
  assert.equal("voice" in payload.session, false)
  assert.equal("modalities" in payload.session, false)
})

test("GA websocket connect does not send the retired beta header", () => {
  const config = realtimeConnectConfig({ apiKey: "sk-test", model: "gpt-realtime" })
  assert.equal(config.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime")
  assert.equal(config.headers.Authorization, "Bearer sk-test")
  assert.equal("OpenAI-Beta" in config.headers, false)
})

test("function call events dispatch tools and return output", async () => {
  const socket = new FakeSocket()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  createRealtimeSession(socket, {
    onTool: async (name, args) => {
      calls.push({ name, args })
      return { accepted: true, sessionId: "ses_1" }
    },
  })
  socket.emit({
    type: "response.function_call_arguments.done",
    name: "prompt_session",
    call_id: "call_1",
    arguments: JSON.stringify({ session_id: "ses_1", prompt: "go" }),
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls[0]?.name, "prompt_session")
  const output = socket.sent.find((row) => (row as { type: string }).type === "conversation.item.create") as {
    item: { output: string }
  }
  assert.match(output.item.output, /accepted/)
})

test("GA function calls also arrive on response.output_item.done", async () => {
  const socket = new FakeSocket()
  const calls: string[] = []
  createRealtimeSession(socket, {
    onTool: async (name) => {
      calls.push(name)
      return { ok: true }
    },
  })
  socket.emit({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call_dup",
      name: "list_sessions",
      arguments: "{}",
    },
  })
  socket.emit({
    type: "response.function_call_arguments.done",
    name: "list_sessions",
    call_id: "call_dup",
    arguments: "{}",
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, ["list_sessions"])
})

test("speech started does not send unsupported GA client events", () => {
  const socket = new FakeSocket()
  let started = false
  createRealtimeSession(socket, { onSpeechStarted: () => { started = true } })
  socket.emit({ type: "input_audio_buffer.speech_started" })
  assert.equal(started, true)
  assert.deepEqual(socket.sent, [])
})

test("ignores benign cancellation errors", () => {
  const socket = new FakeSocket()
  const errors: string[] = []
  createRealtimeSession(socket, { onError: (message) => errors.push(message) })
  socket.emit({
    type: "error",
    error: { message: "Cancellation failed: no active response found" },
  })
  assert.deepEqual(errors, [])
  socket.emit({
    type: "error",
    error: { message: "Invalid value: 'output_audio_buffer.clear'." },
  })
  assert.deepEqual(errors, [])
  socket.emit({
    type: "error",
    error: { message: "The Realtime Beta API is no longer supported" },
  })
  assert.equal(errors[0], "The Realtime Beta API is no longer supported")
})

test("audio deltas decode from base64", () => {
  const socket = new FakeSocket()
  const chunks: Buffer[] = []
  createRealtimeSession(socket, { onAudioDelta: (pcm) => chunks.push(pcm) })
  socket.emit({ type: "response.output_audio.delta", delta: Buffer.from("hi").toString("base64") })
  assert.equal(chunks[0]?.toString(), "hi")
})
