import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultSpokenInstructions, resolveSpokenInstructions, SUPERVISOR_INSTRUCTIONS } from "../src/instructions.ts"
import { fetchVoiceSamplePcm, sampleTextForVoice, TTS_SAMPLE_MODEL } from "../src/preview.ts"
import { REALTIME_VOICES, isRealtimeVoice, resolveOptions, voiceMeta } from "../src/types.ts"

test("realtime voice catalog includes marin, cedar, and sample lines", () => {
  const ids = REALTIME_VOICES.map((voice) => voice.id)
  assert.ok(ids.includes("marin"))
  assert.ok(ids.includes("cedar"))
  assert.equal(REALTIME_VOICES.length, 10)
  assert.equal(isRealtimeVoice("marin"), true)
  assert.equal(isRealtimeVoice("robot"), false)
  assert.match(voiceMeta("cedar")?.sample ?? "", /Cedar/)
})

test("custom spoken instructions replace the default prompt", () => {
  assert.equal(resolveSpokenInstructions("gpt-realtime"), SUPERVISOR_INSTRUCTIONS)
  assert.equal(defaultSpokenInstructions("gpt-live-1"), SUPERVISOR_INSTRUCTIONS)
  assert.match(SUPERVISOR_INSTRUCTIONS, /Talk to the user out loud/)
  assert.equal(
    resolveSpokenInstructions("gpt-realtime", "  Talk like a pirate.  "),
    "Talk like a pirate.",
  )
})

test("resolveOptions still reads voice and instructions from plugin config", () => {
  const resolved = resolveOptions({ voice: "echo", instructions: "Be terse." })
  assert.equal(resolved.voice, "echo")
  assert.equal(resolved.instructions, "Be terse.")
})

test("fetchVoiceSamplePcm posts PCM speech for the chosen voice", async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const pcm = await fetchVoiceSamplePcm({
    apiKey: "sk-test",
    voice: "marin",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return {
        ok: true,
        arrayBuffer: async () => Uint8Array.from(Buffer.from("pcm-bytes")).buffer,
      } as Response
    },
  })
  assert.equal(calls[0]?.url, "https://api.openai.com/v1/audio/speech")
  assert.deepEqual(calls[0]?.body, {
    model: TTS_SAMPLE_MODEL,
    voice: "marin",
    input: sampleTextForVoice("marin"),
    response_format: "pcm",
  })
  assert.equal(Buffer.from(pcm).toString(), "pcm-bytes")
})
