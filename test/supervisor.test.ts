import assert from "node:assert/strict"
import { test } from "node:test"
import { MemoryAudio } from "../src/audio.ts"
import { createVoiceSupervisor as createSupervisor } from "../src/supervisor.ts"
import type { SessionClient } from "../src/client.ts"
import type { RealtimeSession } from "../src/realtime.ts"
import type { RealtimeHandlers } from "../src/realtime.ts"
import { deferred, tick, until } from "./helpers.ts"

const createVoiceSupervisor = (input: Parameters<typeof createSupervisor>[0]) => createSupervisor({
  resolveKey: () => ({ key: "sk-test", source: "plugin", hint: "test" }),
  ...input,
})

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

test("holds the microphone while a realtime model is speaking", async () => {
  const audio = new MemoryAudio()
  const sent: number[] = []
  let onAudioDelta: ((pcm: Buffer) => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", model: "gpt-realtime" },
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
  assert.equal(sent.length, 1)
  await supervisor.stop()
})

test("realtime speech during playback does not unmute the mic", async () => {
  const audio = new MemoryAudio()
  const sent: number[] = []
  let onAudioDelta: ((pcm: Buffer) => void) | undefined
  let onSpeechStarted: (() => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", model: "gpt-realtime" },
    audio,
    connect: async (options) => {
      onAudioDelta = options.handlers.onAudioDelta
      onSpeechStarted = options.handlers.onSpeechStarted
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
  audio.push(Buffer.from([5, 6]))
  assert.equal(sent.length, 0)
  onSpeechStarted?.()
  audio.push(Buffer.from([7, 8, 9, 10]))
  assert.equal(sent.length, 0)
  await supervisor.stop()
})

test("unexpected socket close enters reconnecting state", async () => {
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
  assert.equal(supervisor.state().phase, "reconnecting")
  assert.equal(supervisor.state().desiredOn, true)
  assert.match(toasts.join(" "), /Reconnecting/)
  await supervisor.stop()
})

test("transient disconnect automatically reconnects", async () => {
  let connects = 0
  let onClose: ((reason: string) => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio: new MemoryAudio(),
    connect: async (options) => {
      connects += 1
      onClose = options.handlers.onClose
      return { sendAudio() {}, injectText() {}, close() {} }
    },
  })
  await supervisor.start()
  onClose?.("network changed")
  await new Promise((resolve) => setTimeout(resolve, 1300))
  assert.equal(connects, 2)
  assert.equal(supervisor.state().phase, "connected")
  await supervisor.stop()
})

test("inactivity timeout automatically stops voice", async () => {
  const toasts: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: {
      apiKey: "sk-test",
      inactivityTimeoutMinutes: 0.0002,
      costWarningMinutes: 0,
      maxSessionDurationMinutes: 0,
    },
    audio: new MemoryAudio(),
    connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
    hooks: { toast: ({ message }) => toasts.push(message) },
  })
  await supervisor.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(supervisor.state().phase, "off")
  assert.match(toasts.join(" "), /inactivity/)
})

test("cost warning and maximum duration apply to active time", async () => {
  const toasts: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: {
      apiKey: "sk-test",
      inactivityTimeoutMinutes: 0,
      costWarningMinutes: 0.00015,
      maxSessionDurationMinutes: 0.0004,
    },
    audio: new MemoryAudio(),
    connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
    hooks: { toast: ({ message }) => toasts.push(message) },
  })
  await supervisor.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(supervisor.state().phase, "off")
  assert.equal(supervisor.state().costWarningShown, true)
  assert.match(toasts.join(" "), /billed by OpenAI/)
  assert.match(toasts.join(" "), /session limit/)
})

test("API key is validated before it is saved", async () => {
  const saved: string[] = []
  const toasts: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: {},
    audio: new MemoryAudio(),
    validateKey: async (key) => {
      if (key === "bad") throw new Error("Invalid key")
    },
    saveKey: (key) => {
      saved.push(key)
      return "keychain"
    },
    hooks: { toast: ({ message }) => toasts.push(message) },
  })
  await supervisor.setApiKey("bad")
  assert.deepEqual(saved, [])
  await supervisor.setApiKey("sk-valid")
  assert.deepEqual(saved, ["sk-valid"])
  assert.match(toasts.join(" "), /validated/)
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

test("setVoice updates the speaker without starting voice", async () => {
  const voices: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", voice: "marin" },
    audio: new MemoryAudio(),
    connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
    hooks: { onVoiceChange: (voice) => voices.push(voice) },
  })
  assert.equal(supervisor.voice(), "marin")
  await supervisor.setVoice("cedar")
  assert.equal(supervisor.voice(), "cedar")
  assert.equal(supervisor.state().phase, "off")
  assert.deepEqual(voices, ["cedar"])
})

test("setVoice reconnects when voice is already on", async () => {
  let connects = 0
  let usedVoice = ""
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test", voice: "marin" },
    audio: new MemoryAudio(),
    connect: async (options) => {
      connects += 1
      usedVoice = options.voice
      return { sendAudio() {}, injectText() {}, close() {} }
    },
  })
  await supervisor.start()
  assert.equal(connects, 1)
  await supervisor.setVoice("coral")
  assert.equal(supervisor.voice(), "coral")
  assert.equal(usedVoice, "coral")
  assert.equal(connects, 2)
  await supervisor.stop()
})

test("setInstructions saves a custom spoken prompt", async () => {
  const saved: Array<string | undefined> = []
  let used: string | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio: new MemoryAudio(),
    connect: async (options) => {
      used = options.instructions
      return { sendAudio() {}, injectText() {}, close() {} }
    },
    hooks: { onInstructionsChange: (text) => saved.push(text) },
  })
  await supervisor.setInstructions("Talk like a dry British butler. Keep it to one sentence.")
  assert.match(supervisor.instructions() ?? "", /British butler/)
  assert.match(supervisor.statusText(), /prompt: custom/)
  assert.equal(saved.at(-1)?.includes("butler"), true)
  await supervisor.start()
  assert.match(used ?? "", /British butler/)
  await supervisor.stop()
  await supervisor.setInstructions(undefined)
  assert.equal(supervisor.instructions(), undefined)
  assert.match(supervisor.statusText(), /prompt: default/)
})

test("previewVoice plays a TTS sample through speakers", async () => {
  const audio = new MemoryAudio()
  const fetched: string[] = []
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio,
    connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
    fetchSpeech: async ({ voice }) => {
      fetched.push(voice)
      return Buffer.from("sample")
    },
  })
  await supervisor.previewVoice("cedar")
  assert.deepEqual(fetched, ["cedar"])
  assert.equal(audio.played[0]?.toString(), "sample")
})

test("double toggle while connecting only starts once", async () => {
  let connects = 0
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio: new MemoryAudio(),
    connect: async () => {
      connects += 1
      await new Promise((resolve) => setTimeout(resolve, 40))
      return { sendAudio() {}, injectText() {}, close() {} }
    },
  })
  await Promise.all([supervisor.toggle(), supervisor.toggle(), supervisor.toggle()])
  assert.equal(connects, 1)
  assert.equal(supervisor.state().phase, "connected")
  assert.equal(supervisor.chip(), "● VOICE")
  await supervisor.stop()
  assert.equal(supervisor.chip(), "○ voice")
})

test("audio after stop does not flip the chip back on", async () => {
  let onAudioDelta: ((pcm: Buffer) => void) | undefined
  const supervisor = createVoiceSupervisor({
    client,
    options: { apiKey: "sk-test" },
    audio: new MemoryAudio(),
    connect: async (options) => {
      onAudioDelta = options.handlers.onAudioDelta
      return { sendAudio() {}, injectText() {}, close() {} }
    },
  })
  await supervisor.start()
  onAudioDelta?.(Buffer.from([1, 2]))
  assert.equal(supervisor.chip(), "● VOICE")
  await supervisor.stop()
  assert.equal(supervisor.state().phase, "off")
  onAudioDelta?.(Buffer.from([3, 4]))
  assert.equal(supervisor.state().phase, "off")
  assert.equal(supervisor.chip(), "○ voice")
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

test("an older audio-done callback cannot unmute a newer reply", async (t) => {
  const audio = new MemoryAudio()
  let handlers!: RealtimeHandlers
  let sent = 0
  const supervisor = createVoiceSupervisor({ client, audio, connect: async (options) => {
    handlers = options.handlers
    return { sendAudio() { sent++ }, injectText() {}, close() {} }
  } })
  t.after(() => supervisor.dispose())
  await supervisor.start()
  handlers.onAudioDelta?.(Buffer.alloc(2))
  const older = handlers.onAudioDone?.()
  await tick()
  handlers.onAudioDelta?.(Buffer.alloc(4800))
  await older
  audio.push(Buffer.alloc(2))
  assert.equal(sent, 0)
  assert.equal(supervisor.state().phase, "speaking")
  await handlers.onAudioDone?.()
  audio.push(Buffer.alloc(2))
  assert.equal(sent, 1)
  assert.equal(supervisor.state().phase, "connected")
})

test("stop cancels pending playback waits and suppresses stale callbacks", async () => {
  let handlers!: RealtimeHandlers
  const supervisor = createVoiceSupervisor({ client, audio: new MemoryAudio(), connect: async (options) => {
    handlers = options.handlers
    return { sendAudio() {}, injectText() {}, close() {} }
  } })
  await supervisor.start()
  handlers.onAudioDelta?.(Buffer.alloc(48000 * 60))
  const done = handlers.onAudioDone?.()
  await supervisor.stop()
  await done
  assert.equal(supervisor.state().phase, "off")
})

test("key resolution failure is recoverable on the next start", async (t) => {
  let attempts = 0
  const supervisor = createVoiceSupervisor({ client, audio: new MemoryAudio(), options: { autoReconnect: false },
    resolveKey: () => {
      if (++attempts === 1) throw new Error("Key store unavailable")
      return { key: "test", source: "plugin", hint: "test" }
    }, connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }),
  })
  t.after(() => supervisor.dispose())
  await supervisor.start()
  assert.equal(supervisor.state().phase, "error")
  await supervisor.start()
  assert.equal(supervisor.state().phase, "connected")
})

test("stop during capture startup cannot resurrect the connection", async () => {
  const audio = new MemoryAudio()
  const capture = deferred()
  audio.startCapture = () => capture.promise
  const supervisor = createVoiceSupervisor({ client, audio, connect: async () => ({ sendAudio() {}, injectText() {}, close() {} }) })
  const opening = supervisor.start()
  await tick()
  await supervisor.stop()
  capture.resolve()
  await opening
  assert.equal(supervisor.state().phase, "off")
  assert.equal(supervisor.state().desiredOn, false)
})

test("playback failure surfaces instead of producing an unhandled rejection", async (t) => {
  const audio = new MemoryAudio()
  audio.play = async () => { throw new Error("speaker disconnected") }
  let handlers!: RealtimeHandlers
  const supervisor = createVoiceSupervisor({ client, audio, options: { autoReconnect: false }, connect: async (options) => {
    handlers = options.handlers
    return { sendAudio() {}, injectText() {}, close() {} }
  } })
  t.after(() => supervisor.dispose())
  await supervisor.start()
  handlers.onAudioDelta?.(Buffer.alloc(2))
  await until(() => supervisor.state().phase === "error")
  assert.match(supervisor.state().error ?? "", /speaker disconnected/)
})
