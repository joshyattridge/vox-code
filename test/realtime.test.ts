import assert from "node:assert/strict"
import { test } from "node:test"
import { Buffer } from "node:buffer"
import { createRealtimeSession, openRealtime, realtimeConnectConfig, sessionUpdatePayload } from "../src/realtime.ts"

import { FakeSocket, deferred, tick } from "./helpers.ts"

test("session update uses the GA realtime shape", () => {
  const payload = sessionUpdatePayload({ voice: "cedar", model: "gpt-realtime" })
  assert.equal(payload.session.type, "realtime")
  assert.equal(payload.session.model, "gpt-realtime")
  assert.deepEqual(payload.session.output_modalities, ["audio"])
  assert.equal(payload.session.audio.output.voice, "cedar")
  assert.equal(payload.session.audio.input.format.type, "audio/pcm")
  assert.equal(payload.session.audio.input.turn_detection.type, "semantic_vad")
  assert.equal(payload.session.audio.input.turn_detection.eagerness, "high")
  assert.equal(payload.session.audio.input.turn_detection.interrupt_response, false)
  const names = payload.session.tools.map((tool) => tool.name)
  assert.ok(names.includes("create_session"))
  assert.ok(names.includes("prompt_session"))
  assert.match(payload.session.instructions, /create_session/)
  assert.equal("voice" in payload.session, false)
  assert.equal("modalities" in payload.session, false)
})

test("session update uses a custom spoken prompt when provided", () => {
  const payload = sessionUpdatePayload({
    voice: "coral",
    model: "gpt-realtime",
    instructions: "Talk like a pirate. Still dispatch coding sessions.",
  })
  assert.match(payload.session.instructions, /pirate/)
  assert.match(payload.session.instructions, /create_session/)
  assert.equal(payload.session.audio.output.voice, "coral")
})

test("GA websocket connect does not send the retired beta header", () => {
  const config = realtimeConnectConfig({ apiKey: "sk-test", model: "gpt-realtime" })
  assert.equal(config.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime")
  assert.equal(config.headers.Authorization, "Bearer sk-test")
  assert.equal("OpenAI-Beta" in config.headers, false)
})

test("failed realtime handshake closes the socket", async () => {
  const socket = new FakeSocket()
  const opening = openRealtime({
    apiKey: "sk-test",
    model: "gpt-realtime",
    voice: "marin",
    handlers: {},
    socket,
  })
  socket.emit({ type: "error", error: { message: "handshake failed" } })
  await assert.rejects(opening, /handshake failed/)
  assert.equal(socket.closed, true)
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

test("assistant audio clears the input buffer so leftover mic cannot barge in", () => {
  const socket = new FakeSocket()
  createRealtimeSession(socket, {})
  socket.emit({
    type: "response.output_audio.delta",
    item_id: "item_abc",
    delta: Buffer.alloc(4800).toString("base64"),
  })
  const clear = socket.sent.find((row) => (row as { type: string }).type === "input_audio_buffer.clear")
  assert.equal((clear as { type: string }).type, "input_audio_buffer.clear")
  socket.sent.length = 0
  socket.emit({
    type: "response.output_audio.delta",
    item_id: "item_abc",
    delta: Buffer.alloc(4800).toString("base64"),
  })
  assert.deepEqual(socket.sent, [])
})

test("speech started does not truncate playback", () => {
  const socket = new FakeSocket()
  let started = false
  createRealtimeSession(socket, { onSpeechStarted: () => { started = true } })
  socket.emit({
    type: "response.output_audio.delta",
    item_id: "item_abc",
    delta: Buffer.alloc(4800).toString("base64"),
  })
  socket.sent.length = 0
  socket.emit({ type: "input_audio_buffer.speech_started" })
  assert.equal(started, true)
  assert.equal(
    socket.sent.some((row) => (row as { type: string }).type === "conversation.item.truncate"),
    false,
  )
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

test("input audio appends only complete PCM16 samples", () => {
  const socket = new FakeSocket()
  const session = createRealtimeSession(socket, {})
  session.sendAudio(Buffer.from([1, 2, 3]))
  assert.equal(socket.sent.length, 1)
  const first = socket.sent[0] as { audio: string }
  assert.equal(Buffer.from(first.audio, "base64").equals(Buffer.from([1, 2])), true)
  session.sendAudio(Buffer.from([4, 5, 6]))
  const second = socket.sent[1] as { audio: string }
  assert.equal(Buffer.from(second.audio, "base64").equals(Buffer.from([3, 4, 5, 6])), true)
})

test("parallel tools wait for the terminal response and all results before one continuation", async () => {
  const socket = new FakeSocket()
  const slow = deferred<unknown>()
  const calls: string[] = []
  createRealtimeSession(socket, { onTool: async (name) => {
    calls.push(name)
    return name === "slow" ? slow.promise : { ok: true }
  } })
  socket.emit({ type: "response.created" })
  const call = (id: string, name: string) => socket.emit({
    type: "response.function_call_arguments.done", call_id: id, name, arguments: "{}",
  })
  call("a", "fast")
  await tick()
  call("b", "slow")
  call("a", "fast")
  assert.equal(socket.sent.filter((e) => e.type === "response.create").length, 0)
  socket.emit({ type: "response.done", response: { status: "completed" } })
  await tick()
  assert.equal(socket.sent.filter((e) => e.type === "response.create").length, 0)
  slow.resolve({ ok: true })
  await tick()
  assert.deepEqual(calls, ["fast", "slow"])
  assert.equal(socket.sent.filter((e) => e.type === "conversation.item.create").length, 2)
  assert.equal(socket.sent.filter((e) => e.type === "response.create").length, 1)
})

test("worker updates queue during a response and coalesce into one follow-up", () => {
  const socket = new FakeSocket()
  const session = createRealtimeSession(socket, {})
  socket.emit({ type: "response.created" })
  session.injectText("first worker finished")
  session.injectText("second worker finished")
  assert.equal(socket.sent.filter((e) => e.type === "response.create").length, 0)
  socket.emit({ type: "response.done", response: { status: "completed" } })
  assert.equal(socket.sent.filter((e) => e.type === "response.create").length, 1)
  session.close()
})

test("late tool results and audio are ignored after close", async () => {
  const socket = new FakeSocket()
  const result = deferred<unknown>()
  let audio = 0
  const session = createRealtimeSession(socket, { onTool: () => result.promise, onAudioDelta: () => { audio++ } })
  socket.emit({ type: "response.function_call_arguments.done", call_id: "a", name: "slow", arguments: "{}" })
  session.close()
  result.resolve({ ok: true })
  socket.emit({ type: "response.output_audio.delta", delta: "AAAA" })
  await tick()
  assert.equal(audio, 0)
  assert.deepEqual(socket.sent, [])
})

test("readiness requires session.updated and handshake listeners are removed", async () => {
  const socket = new FakeSocket()
  let opens = 0
  const opening = openRealtime({ apiKey: "test", model: "gpt-realtime", voice: "marin", socket, handlers: { onOpen: () => { opens++ } } })
  socket.emit({ type: "session.created" })
  assert.equal(opens, 0)
  socket.emit({ type: "session.updated" })
  const session = await opening
  socket.emit({ type: "session.updated" })
  assert.equal(opens, 1)
  assert.equal(socket.events.listenerCount("message"), 1)
  assert.equal(socket.sent.filter((e) => e.type === "session.update").length, 1)
  session.close()
})

test("socket close rejects startup immediately", async () => {
  const socket = new FakeSocket()
  const opening = openRealtime({ apiKey: "test", model: "gpt-realtime", voice: "marin", socket, handlers: {} })
  socket.close()
  await assert.rejects(opening, /closed during startup/)
})

test("a VAD response-create race retries after completion without reconnecting", () => {
  const socket = new FakeSocket()
  const errors: string[] = []
  const session = createRealtimeSession(socket, { onError: (message) => errors.push(message) })
  session.injectText("worker update")
  socket.emit({ type: "error", error: { code: "conversation_already_has_active_response", message: "active response" } })
  socket.emit({ type: "response.done", response: { status: "completed" } })
  assert.equal(socket.sent.filter((e) => e.type === "response.create").length, 2)
  assert.deepEqual(errors, [])
  session.close()
})

test("an active-response message without an error code is retried", () => {
  const socket = new FakeSocket()
  const errors: string[] = []
  const session = createRealtimeSession(socket, { onError: (message) => errors.push(message) })
  session.injectText("worker update")
  socket.emit({
    type: "error",
    error: { message: "Conversation already has an active response in progress: resp_123." },
  })
  socket.emit({ type: "response.done", response: { status: "completed" } })
  assert.equal(socket.sent.filter((event) => event.type === "response.create").length, 2)
  assert.deepEqual(errors, [])
  session.close()
})
