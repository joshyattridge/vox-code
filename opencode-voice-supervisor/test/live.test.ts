import assert from "node:assert/strict"
import { test } from "node:test"
import { Buffer } from "node:buffer"
import { createLiveSession, liveConnectConfig, sessionStartPayload } from "../src/live.ts"
import { isLiveModel } from "../src/types.ts"

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

test("gpt-live-1 is recognized as a Live model", () => {
  assert.equal(isLiveModel("gpt-live-1"), true)
  assert.equal(isLiveModel("gpt-live-1-preview"), true)
  assert.equal(isLiveModel("gpt-realtime"), false)
  assert.equal(isLiveModel("gpt-realtime-2.1"), false)
})

test("live websocket connects to /v1/live/sessions", () => {
  const config = liveConnectConfig({ apiKey: "sk-test" })
  assert.equal(config.url, "wss://api.openai.com/v1/live/sessions")
  assert.equal(config.headers.Authorization, "Bearer sk-test")
  assert.equal("OpenAI-Beta" in config.headers, false)
})

test("session start uses GPT-Live plus Responses delegation", () => {
  const payload = sessionStartPayload({
    model: "gpt-live-1",
    voice: "marin",
    backendModel: "gpt-5.6-luna",
  })
  assert.equal(payload.type, "session.start")
  assert.equal(payload.session.model, "gpt-live-1")
  assert.equal(payload.session.audio.format.type, "audio/pcm")
  assert.equal(payload.session.audio.output.voice, "marin")
  assert.equal(payload.session.delegation.type, "responses")
  assert.equal(payload.session.delegation.responses.model, "gpt-5.6-luna")
  assert.equal(payload.session.delegation.responses.reasoning.effort, "low")
  assert.equal(payload.session.delegation.responses.parallel_tool_calls, true)
  const names = payload.session.delegation.responses.tools.map((tool) => tool.name)
  assert.ok(names.includes("create_session"))
  assert.ok(names.includes("prompt_session"))
})

test("live session start uses a custom spoken prompt when provided", () => {
  const payload = sessionStartPayload({
    model: "gpt-live-1",
    voice: "cedar",
    instructions: "Be a calm coach. One sentence at a time.",
    backendModel: "gpt-5.6-luna",
  })
  assert.match(payload.session.instructions, /calm coach/)
  assert.equal(payload.session.audio.output.voice, "cedar")
})

test("live audio uses session.input_audio.append", () => {
  const socket = new FakeSocket()
  const session = createLiveSession(socket, {})
  session.sendAudio(Buffer.from([1, 2, 3, 4]))
  assert.equal((socket.sent[0] as { type: string }).type, "session.input_audio.append")
})

test("live injectText appends spoken commentary", () => {
  const socket = new FakeSocket()
  const session = createLiveSession(socket, {})
  session.injectText("worker ses_1 is idle")
  const sent = socket.sent[0] as { type: string; delegation_id: null; content: string }
  assert.equal(sent.type, "session.commentary.append")
  assert.equal(sent.delegation_id, null)
  assert.match(sent.content, /idle/)
})

test("live function calls arrive inside response.event", async () => {
  const socket = new FakeSocket()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  createLiveSession(socket, {
    onTool: async (name, args) => {
      calls.push({ name, args })
      return { accepted: true }
    },
  })
  socket.emit({
    type: "response.event",
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "prompt_session",
        arguments: JSON.stringify({ session_id: "ses_1", prompt: "go" }),
      },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls[0]?.name, "prompt_session")
  const output = socket.sent.find((row) => (row as { type: string }).type === "response.item.create") as {
    item: { output: string; call_id: string }
  }
  assert.equal(output.item.call_id, "call_1")
  assert.match(output.item.output, /accepted/)
  const continued = socket.sent.find((row) => (row as { type: string }).type === "response.create") as {
    type: string
    event_id?: string
  }
  assert.equal(continued.type, "response.create")
  assert.ok(continued.event_id)
  assert.equal(
    socket.sent.some((row) => (row as { type: string }).type === "session.commentary.append"),
    false,
  )
})

test("live audio deltas decode from base64", () => {
  const socket = new FakeSocket()
  const chunks: Buffer[] = []
  createLiveSession(socket, { onAudioDelta: (pcm) => chunks.push(pcm) })
  socket.emit({ type: "session.output_audio.delta", delta: Buffer.from("hi").toString("base64") })
  assert.equal(chunks[0]?.toString(), "hi")
  socket.emit({ type: "session.output_audio.delta", audio: Buffer.from("ok").toString("base64") })
  assert.equal(chunks[1]?.toString(), "ok")
})

test("live session.closed notifies the supervisor", () => {
  const socket = new FakeSocket()
  const closes: string[] = []
  createLiveSession(socket, { onClose: (reason) => closes.push(reason) })
  socket.emit({ type: "session.closed" })
  assert.deepEqual(closes, ["session.closed"])
})

test("live session.started opens; session.updated does not", () => {
  const socket = new FakeSocket()
  let opens = 0
  createLiveSession(socket, { onOpen: () => {
    opens += 1
  } })
  socket.emit({ type: "session.updated" })
  assert.equal(opens, 0)
  socket.emit({ type: "session.started" })
  assert.equal(opens, 1)
})
