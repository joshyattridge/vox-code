import assert from "node:assert/strict"
import { test } from "node:test"
import { pcmRms } from "../src/audio.ts"
import { openRealtime, type RealtimeSession } from "../src/realtime.ts"
import { openLive } from "../src/live.ts"

for (const live of [false, true]) {
const flag = live ? "OPENAI_LIVE_SMOKE" : "OPENAI_REALTIME_SMOKE"
const enabled = process.env[flag] === "1" && Boolean(process.env.OPENAI_API_KEY)

test(
  `real ${live ? "Live" : "Realtime"} API connects and returns non-silent PCM audio`,
  {
    skip: enabled ? false : `set ${flag}=1 and OPENAI_API_KEY`,
    timeout: 45_000,
  },
  async () => {
    let session: RealtimeSession | undefined
    let opened = 0
    let audioBytes = 0
    let peakRms = 0
    let completed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inputTimer: ReturnType<typeof setInterval> | undefined
    let ended = false

    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("No non-silent audio within 35 seconds")), 35_000)
        const connect = live ? openLive : openRealtime
        void connect({
          apiKey: process.env.OPENAI_API_KEY!,
          model: live ? "gpt-live-1" : process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime",
          voice: "marin",
          instructions: "For this smoke test, do not call tools. Speak one short sentence.",
          handlers: {
            onOpen: () => {
              opened += 1
            },
            onAudioDelta: (pcm) => {
              assert.equal(pcm.length % 2, 0)
              audioBytes += pcm.length
              peakRms = Math.max(peakRms, pcmRms(pcm))
              if (live && peakRms > 100 && audioBytes >= 4800) {
                completed = true
                resolve()
              }
            },
            onAudioDone: () => {
              if (!live) {
                completed = true
                resolve()
              }
            },
            onError: (message) => reject(new Error(message)),
            onClose: (reason) => {
              if (!completed) reject(new Error(`closed before audio completed: ${reason}`))
            },
          },
        }).then((connected) => {
          if (ended) { connected.close(); return }
          session = connected
          if (live) inputTimer = setInterval(() => connected.sendAudio(Buffer.alloc(960)), 20)
          connected.injectText("Say exactly: Realtime smoke test passed.")
        }, reject)
      })

      assert.ok(opened > 0, "session never reached the opened state")
      assert.ok(audioBytes > 0, "no output PCM was delivered")
      assert.ok(peakRms > 0, "output PCM was silent")
    } finally {
      ended = true
      clearTimeout(timer)
      clearInterval(inputTimer)
      session?.close()
    }
  },
)
}
