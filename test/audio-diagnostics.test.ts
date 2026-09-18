import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import {
  analyzeAssistantPcm,
  assistantAudioMetricsPath,
  assistantAudioPath,
  persistAssistantAudio,
} from "../src/audio-diagnostics.ts"
import { makeSinePcm } from "../src/audio.ts"
import { SAMPLE_RATE } from "../src/types.ts"

test("latest assistant capture is a private WAV containing exact provider PCM", () => {
  const previous = process.env.VOICE_TEST_AUDIO_CAPTURE
  process.env.VOICE_TEST_AUDIO_CAPTURE = "1"
  try {
    const first = makeSinePcm(440, 0.1)
    persistAssistantAudio(first, analyzeAssistantPcm(first, {
      packets: 3,
      maxPacketGapMs: 25,
      bufferDepletions: 0,
      truncated: false,
    }))
    const second = makeSinePcm(660, 0.04)
    const metrics = analyzeAssistantPcm(second, {
      packets: 2,
      maxPacketGapMs: 18,
      bufferDepletions: 0,
      truncated: false,
    })
    persistAssistantAudio(second, metrics)

    const wav = readFileSync(assistantAudioPath())
    assert.equal(wav.subarray(0, 4).toString(), "RIFF")
    assert.equal(wav.subarray(8, 12).toString(), "WAVE")
    assert.equal(wav.readUInt32LE(24), SAMPLE_RATE)
    assert.equal(wav.readUInt32LE(40), second.length)
    assert.deepEqual(wav.subarray(44), second)
    assert.equal(statSync(assistantAudioPath()).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(assistantAudioMetricsPath(), "utf8")), metrics)
  } finally {
    if (previous === undefined) delete process.env.VOICE_TEST_AUDIO_CAPTURE
    else process.env.VOICE_TEST_AUDIO_CAPTURE = previous
  }
})

test("assistant diagnostics measure provider-side silence", () => {
  const pcm = Buffer.concat([
    makeSinePcm(440, 0.02),
    Buffer.alloc(SAMPLE_RATE * 2 * 0.25),
    makeSinePcm(440, 0.02),
  ])
  const metrics = analyzeAssistantPcm(pcm, {
    packets: 4,
    maxPacketGapMs: 40,
    bufferDepletions: 1,
    truncated: false,
  })
  assert.ok(metrics.longestNearSilenceMs >= 249)
  assert.equal(metrics.durationMs, 290)
  assert.equal(metrics.packets, 4)
  assert.equal(metrics.bufferDepletions, 1)
})
