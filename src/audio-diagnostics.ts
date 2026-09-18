import { createHash } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { stateFilePath } from "./persist.ts"
import { SAMPLE_RATE } from "./types.ts"

export type AssistantAudioMetrics = {
  bytes: number
  durationMs: number
  rms: number
  longestNearSilenceMs: number
  sha256: string
  packets: number
  maxPacketGapMs: number
  bufferDepletions: number
  truncated: boolean
  capturedAt: string
}

export function assistantAudioPath() {
  return stateFilePath().replace(/state\.json$/, "latest-assistant.wav")
}

export function assistantAudioMetricsPath() {
  return stateFilePath().replace(/state\.json$/, "latest-assistant.json")
}

export function wavFromPcm(pcm: Buffer, rate = SAMPLE_RATE) {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function analyzeAssistantPcm(
  pcm: Buffer,
  delivery: Pick<AssistantAudioMetrics, "packets" | "maxPacketGapMs" | "bufferDepletions" | "truncated">,
): AssistantAudioMetrics {
  const samples = Math.floor(pcm.length / 2)
  let squares = 0
  let quiet = 0
  let longestQuiet = 0
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2)
    squares += sample * sample
    if (Math.abs(sample) <= 128) {
      quiet += 1
      longestQuiet = Math.max(longestQuiet, quiet)
    } else quiet = 0
  }
  return {
    bytes: pcm.length,
    durationMs: Math.round((samples / SAMPLE_RATE) * 1000),
    rms: samples ? Math.round(Math.sqrt(squares / samples)) : 0,
    longestNearSilenceMs: Math.round((longestQuiet / SAMPLE_RATE) * 1000),
    sha256: createHash("sha256").update(pcm).digest("hex"),
    ...delivery,
    capturedAt: new Date().toISOString(),
  }
}

export function persistAssistantAudio(pcm: Buffer, metrics: AssistantAudioMetrics) {
  if (!pcm.length || process.env.NODE_TEST_CONTEXT && process.env.VOICE_TEST_AUDIO_CAPTURE !== "1") return
  const wavPath = assistantAudioPath()
  const metricsPath = assistantAudioMetricsPath()
  const wavTemp = `${wavPath}.${process.pid}.tmp`
  const metricsTemp = `${metricsPath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(wavPath), { recursive: true, mode: 0o700 })
    writeFileSync(wavTemp, wavFromPcm(pcm), { mode: 0o600 })
    writeFileSync(metricsTemp, `${JSON.stringify(metrics, null, 2)}\n`, { mode: 0o600 })
    renameSync(wavTemp, wavPath)
    renameSync(metricsTemp, metricsPath)
  } catch {
    // Diagnostics must never interrupt playback.
  } finally {
    try { rmSync(wavTemp, { force: true }) } catch { /* best effort */ }
    try { rmSync(metricsTemp, { force: true }) } catch { /* best effort */ }
  }
}
