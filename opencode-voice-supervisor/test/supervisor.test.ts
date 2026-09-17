import assert from "node:assert/strict"
import { test } from "node:test"
import { MemoryAudio } from "../src/audio.ts"
import { createVoiceSupervisor } from "../src/supervisor.ts"
import type { SessionClient } from "../src/client.ts"
import type { RealtimeSession } from "../src/realtime.ts"

const client: SessionClient = {
  session: {
    async list() {
      return { data: [] }
    },
    async create() {
      return { data: { id: "ses_1", title: "worker" } }
    },
    async get() {
      return { data: { id: "ses_1", title: "worker" } }
    },
    async status() {
      return { data: {} }
    },
    async abort() {
      return { data: true }
    },
    async promptAsync() {
      return {}
    },
  },
  permission: {
    async respond() {
      return { data: true }
    },
  },
}

test("start without an API key surfaces a TUI error state", async () => {
  const toasts: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: {},
    audio: new MemoryAudio(),
    resolveKey: () => ({ source: "missing", hint: "No OpenAI API key in OpenCode." }),
    hooks: { toast: ({ message }) => toasts.push(message) },
  })
  await supervisor.start()
  assert.equal(supervisor.state().phase, "error")
  assert.match(supervisor.chip(), /error/)
  assert.match(toasts.join(" "), /OpenAI API key/)
})

test("toggle starts when a key and fake realtime session exist", async () => {
  const audio = new MemoryAudio()
  let closed = false
  const fake: RealtimeSession = {
    sendAudio() {},
    injectText() {},
    close() {
      closed = true
    },
  }
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio,
    connect: async () => fake,
  })
  await supervisor.start()
  assert.equal(supervisor.state().phase, "connected")
  assert.equal(supervisor.chip(), "● VOICE")
  assert.equal(audio.capturing, true)
  await supervisor.stop()
  assert.equal(closed, true)
  assert.equal(supervisor.chip(), "○ voice")
})

test("keeps sending microphone audio while the assistant is speaking", async () => {
  const audio = new MemoryAudio()
  const sent: number[] = []
  let onAudioDelta: ((pcm: Buffer) => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio,
    connect: async (options) => {
      onAudioDelta = options.handlers.onAudioDelta
      return {
        sendAudio(pcm) {
          sent.push(pcm.length)
        },
        injectText() {},
        close() {},
      }
    },
  })
  await supervisor.start()
  audio.push(Buffer.from([1, 2]))
  assert.equal(sent.length, 1)
  onAudioDelta?.(Buffer.from([3, 4]))
  audio.push(Buffer.from([5, 6, 7, 8]))
  assert.equal(sent.length, 2)
  await supervisor.stop()
})

test("unexpected socket close toasts and returns to off", async () => {
  const toasts: string[] = []
  let onClose: ((reason: string) => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio: new MemoryAudio(),
    connect: async (options) => {
      onClose = options.handlers.onClose
      return { sendAudio() {}, injectText() {}, close() {} }
    },
    hooks: { toast: ({ message }) => toasts.push(message) },
  })
  await supervisor.start()
  onClose?.("closed")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(supervisor.state().phase, "off")
  assert.match(toasts.join(" "), /disconnected/)
})

test("setModel updates the realtime model without starting voice", async () => {
  const models: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", model: "gpt-realtime" },
    audio: new MemoryAudio(),
    connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
    hooks: { onModelChange: (model) => models.push(model) },
  })
  assert.equal(supervisor.model(), "gpt-realtime")
  await supervisor.setModel("gpt-realtime-2.1-mini")
  assert.equal(supervisor.model(), "gpt-realtime-2.1-mini")
  assert.equal(supervisor.state().phase, "off")
  assert.deepEqual(models, ["gpt-realtime-2.1-mini"])
})

test("setModel reconnects when voice is already on", async () => {
  let connects = 0
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", model: "gpt-realtime" },
    audio: new MemoryAudio(),
    connect: async () => {
      connects += 1
      return { sendAudio() {}, injectText() {}, close() {} }
    },
  })
  await supervisor.start()
  assert.equal(connects, 1)
  await supervisor.setModel("gpt-realtime-2.1")
  assert.equal(supervisor.model(), "gpt-realtime-2.1")
  assert.equal(connects, 2)
  await supervisor.stop()
})

test("setModel can switch to gpt-live-1", async () => {
  const models: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", model: "gpt-realtime" },
    audio: new MemoryAudio(),
    connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
    hooks: { onModelChange: (model) => models.push(model) },
  })
  await supervisor.setModel("gpt-live-1")
  assert.equal(supervisor.model(), "gpt-live-1")
  assert.match(supervisor.statusText(), /backend:/)
  assert.deepEqual(models, ["gpt-live-1"])
})

test("live models keep the microphone open while the assistant is speaking", async () => {
  const audio = new MemoryAudio()
  const sent: number[] = []
  let onAudioDelta: ((pcm: Buffer) => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", model: "gpt-live-1" },
    audio,
    connect: async (options) => {
      onAudioDelta = options.handlers.onAudioDelta
      return {
        sendAudio(pcm) {
          sent.push(pcm.length)
        },
        injectText() {},
        close() {},
      }
    },
  })
  await supervisor.start()
  onAudioDelta?.(Buffer.from([3, 4]))
  audio.push(Buffer.from([5, 6, 7, 8]))
  assert.equal(sent.length, 1)
  await supervisor.stop()
})

test("idle events inject a spoken update only for owned sessions", async () => {
  const injected: string[] = []
  const fake: RealtimeSession = {
    sendAudio() {},
    injectText(text) {
      injected.push(text)
    },
    close() {},
  }
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio: new MemoryAudio(),
    connect: async () => fake,
  })
  await supervisor.start()
  supervisor.handleIdle("ses_unknown")
  assert.equal(injected.length, 0)
  await supervisor.stop()
})
