import assert from "node:assert/strict"
import { test } from "node:test"
import { Buffer } from "node:buffer"
import { createRealtimeSession, sessionUpdatePayload } from "../src/realtime.ts"

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

test("session update registers supervisor tools", () => {
  const payload = sessionUpdatePayload({ voice: "cedar" })
  const names = (payload.session.tools as Array<{ name: string }>).map((tool) => tool.name)
  assert.ok(names.includes("create_session"))
  assert.ok(names.includes("prompt_session"))
  assert.equal(payload.session.voice, "cedar")
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

test("speech started clears playback audio", () => {
  const socket = new FakeSocket()
  let started = false
  createRealtimeSession(socket, { onSpeechStarted: () => { started = true } })
  socket.emit({ type: "input_audio_buffer.speech_started" })
  assert.equal(started, true)
  const types = socket.sent.map((row) => (row as { type: string }).type)
  assert.ok(types.includes("output_audio_buffer.clear"))
})

test("audio deltas decode from base64", () => {
  const socket = new FakeSocket()
  const chunks: Buffer[] = []
  createRealtimeSession(socket, { onAudioDelta: (pcm) => chunks.push(pcm) })
  socket.emit({ type: "response.output_audio.delta", delta: Buffer.from("hi").toString("base64") })
  assert.equal(chunks[0]?.toString(), "hi")
})
