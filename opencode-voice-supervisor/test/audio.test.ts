import assert from "node:assert/strict"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { describeAudioDeps, detectAudio, ffplayArgs, FRAME_BYTES, makeSinePcm, pcmRms, PcmWritePump, PREROLL_BYTES } from "../src/audio.ts"
import { SAMPLE_RATE } from "../src/types.ts"

test("finds Homebrew rec/play even when PATH does not include them", () => {
  if (!existsSync("/opt/homebrew/bin/rec")) return
  const prev = process.env.PATH
  process.env.PATH = "/usr/bin"
  try {
    const found = describeAudioDeps()
    assert.ok(found.includes("rec"), `expected rec, got ${found.join(",")}`)
    assert.ok(found.includes("play"), `expected play, got ${found.join(",")}`)
  } finally {
    process.env.PATH = prev
  }
})

test("playback preroll holds audio until the jitter buffer is full", () => {
  const pump = new PcmWritePump(12, 50, () => 0)
  assert.equal(pump.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), undefined)
  assert.equal(pump.queuedBytes, 8)
  const flushed = pump.push(Buffer.from([9, 10, 11, 12]))
  assert.deepEqual([...(flushed ?? [])], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(pump.flushing, true)
  assert.equal(pump.queuedBytes, 0)
})

test("after preroll, later chunks flush immediately with no silence", () => {
  const pump = new PcmWritePump(8, 1_000, () => 0)
  pump.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  const next = pump.push(Buffer.from([9, 10, 11, 12]))
  assert.deepEqual([...(next ?? [])], [9, 10, 11, 12])
})

test("stalled preroll flushes after a short wait", () => {
  let now = 0
  const pump = new PcmWritePump(12, 50, () => now)
  assert.equal(pump.push(Buffer.from([1, 2, 3, 4])), undefined)
  now = 39
  assert.equal(pump.flushIfWaited(40), undefined)
  now = 40
  const flushed = pump.flushIfWaited(40)
  assert.deepEqual([...(flushed ?? [])], [1, 2, 3, 4])
})

test("short replies stuck in preroll flush when playback drains", () => {
  const pump = new PcmWritePump(12, 50, () => 0)
  assert.equal(pump.push(Buffer.from([1, 2, 3, 4])), undefined)
  const flushed = pump.flushHeld()
  assert.deepEqual([...(flushed ?? [])], [1, 2, 3, 4])
  assert.equal(pump.flushing, true)
  assert.equal(pump.queuedBytes, 0)
})

test("jittered 440Hz sine is reconstructed without inserted zeros", () => {
  const sine = makeSinePcm(440, 1)
  const pump = new PcmWritePump(PREROLL_BYTES, 800, () => 0)
  const written: Buffer[] = []
  const chunk = 4800
  for (let i = 0; i < sine.length; i += chunk) {
    const flushed = pump.push(sine.subarray(i, i + chunk))
    if (flushed) written.push(flushed)
  }
  const rec = Buffer.concat(written)
  assert.equal(rec.length, sine.length)
  assert.ok(rec.equals(sine), "player must not insert silence between network chunks")
})

test("pcmRms is zero for silence and high for a sine", () => {
  assert.equal(pcmRms(Buffer.alloc(960)), 0)
  assert.ok(pcmRms(makeSinePcm(440, 0.05)) > 1000)
})

test("default preroll streams the first chunk immediately", () => {
  const pump = new PcmWritePump()
  const flushed = pump.push(Buffer.from([1, 2, 3, 4]))
  assert.deepEqual([...(flushed ?? [])], [1, 2, 3, 4])
  assert.equal(pump.flushing, true)
})

test("frame and preroll sizes are even PCM16 byte counts", () => {
  assert.equal(FRAME_BYTES % 2, 0)
  assert.equal(PREROLL_BYTES % 2, 0)
  assert.equal(SAMPLE_RATE, 24000)
  assert.equal(PREROLL_BYTES, 0)
})

test("ffplay args play raw PCM16 from stdin", () => {
  const args = ffplayArgs()
  assert.equal(args.includes("-ac"), true)
  assert.equal(args[args.indexOf("-ac") + 1], "1")
  assert.equal(args[args.indexOf("-ar") + 1], "24000")
  assert.equal(args[args.indexOf("-f") + 1], "s16le")
  assert.ok(args.includes("pipe:0"))
  assert.equal(args.includes("-af"), false)
  assert.equal(args.includes("nobuffer+flush_packets"), false)
})

test("sox writes a jittered sine to wav without gaps", async () => {
  const play = existsSync("/opt/homebrew/bin/sox") ? "/opt/homebrew/bin/sox" : undefined
  if (!play) return
  const sine = makeSinePcm(440, 0.8)
  const wav = join(tmpdir(), `vox-jitter-${process.pid}.wav`)
  const child = spawn(play, ["-t", "raw", "-r", "24000", "-e", "signed", "-b", "16", "-c", "1", "-", wav], {
    stdio: ["pipe", "ignore", "ignore"],
  })
  const pump = new PcmWritePump(PREROLL_BYTES, 800, () => Date.now())
  const chunk = 3840
  for (let i = 0; i < sine.length; i += chunk) {
    const flushed = pump.push(sine.subarray(i, i + chunk))
    if (flushed) child.stdin.write(flushed)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const leftover = pump.flushHeld()
  if (leftover) child.stdin.write(leftover)
  child.stdin.end()
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(null)
    }, 3000)
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve(status)
    })
  })
  if (code !== 0) {
    try {
      unlinkSync(wav)
    } catch {}
    return
  }
  const wavBytes = readFileSync(wav)
  unlinkSync(wav)
  const dataStart = wavBytes.indexOf(Buffer.from("data"))
  assert.ok(dataStart >= 0)
  const pcm = wavBytes.subarray(dataStart + 8)
  const usable = pcm.subarray(0, sine.length)
  let maxErr = 0
  for (let i = 0; i < usable.length; i += 2) {
    maxErr = Math.max(maxErr, Math.abs(usable.readInt16LE(i) - sine.readInt16LE(i)))
  }
  assert.equal(usable.length, sine.length)
  assert.ok(maxErr <= 1, `wav diverged from sine, maxErr=${maxErr}`)
})

test("detectAudio prefers sox play for raw PCM streaming", () => {
  if (!existsSync("/opt/homebrew/bin/play") || !existsSync("/opt/homebrew/bin/rec")) return
  const audio = detectAudio()
  assert.equal(audio.name, "sox")
})
