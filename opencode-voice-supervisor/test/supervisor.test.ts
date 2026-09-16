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
      return { data: true }
    },
  },
  async postSessionIdPermissionsPermissionId() {
    return { data: true }
  },
}

test("start without an API key surfaces a TUI error state", async () => {
  delete process.env.OPENAI_API_KEY
  const toasts: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: {},
    audio: new MemoryAudio(),
    hooks: { toast: ({ message }) => toasts.push(message) },
  })
  await supervisor.start()
  assert.equal(supervisor.state().phase, "error")
  assert.match(supervisor.chip(), /error/)
  assert.match(toasts.join(" "), /OPENAI_API_KEY/)
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
})
