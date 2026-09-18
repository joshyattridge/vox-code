import assert from "node:assert/strict"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { describeAudioDeps, detectAudio, ffplayArgs, FRAME_BYTES, makeSinePcm, pcmDurationMs, pcmRms, PcmWritePump, PREROLL_BYTES, StdinPcmPlayer, soxPlayArgs } from "../src/audio.ts"
import { tick, until } from "./helpers.ts"
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
  assert.equal(pcmDurationMs(Buffer.alloc(SAMPLE_RATE * 2)), 1000)
})

test("default preroll buffers 160 ms before speaker playback", () => {
  const pump = new PcmWritePump()
  const flushed = pump.push(Buffer.alloc(PREROLL_BYTES - 2))
  assert.equal(flushed, undefined)
  assert.equal(pump.flushing, false)
  const started = pump.push(Buffer.alloc(2))
  assert.equal(started?.length, PREROLL_BYTES)
  assert.equal(pump.flushing, true)
})

test("frame and preroll sizes are even PCM16 byte counts", () => {
  assert.equal(FRAME_BYTES % 2, 0)
  assert.equal(PREROLL_BYTES % 2, 0)
  assert.equal(SAMPLE_RATE, 24000)
  assert.equal(PREROLL_BYTES, (SAMPLE_RATE * 2 * 160) / 1000)
})

test("a quiet delivery gap re-arms preroll for the next turn", () => {
  let now = 0
  const pump = new PcmWritePump(8, 800, () => now)
  assert.equal(pump.push(Buffer.alloc(8))?.length, 8)
  now = 100
  assert.equal(pump.push(Buffer.alloc(2))?.length, 2)
  now = 901
  assert.equal(pump.push(Buffer.alloc(2)), undefined)
  assert.equal(pump.flushing, false)
  assert.equal(pump.queuedBytes, 2)
  assert.equal(pump.push(Buffer.alloc(6))?.length, 8)
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

test("sox writes a jittered sine to wav without gaps", async (t) => {
  const play = existsSync("/opt/homebrew/bin/sox") ? "/opt/homebrew/bin/sox" : "sox"
  if (spawnSync(play, ["--version"]).status !== 0) { t.skip("sox is not installed"); return }
  const sine = makeSinePcm(440, 0.8)
  const wav = join(tmpdir(), `vox-jitter-${process.pid}.wav`)
  const child = spawn(play, [...soxPlayArgs(), wav], {
    stdio: ["pipe", "ignore", "ignore"],
  })
  t.after(() => { child.kill(); try { unlinkSync(wav) } catch {} })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
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
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  const code = await exited.finally(() => clearTimeout(timer))
  assert.equal(code, 0, "sox must complete successfully")
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

test("speaker backpressure preserves PCM order without duplication", async (t) => {
  const writes: Buffer[] = []
  const callbacks: Array<() => void> = []
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdin = new Writable({ highWaterMark: 1, write(chunk, _, done) {
    writes.push(Buffer.from(chunk))
    callbacks.push(done)
  } })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const player = new StdinPcmPlayer(() => "test-player", [], () => {
    queueMicrotask(() => child.emit("spawn"))
    return child
  })
  t.after(() => player.stop())
  await player.start()
  const first = Buffer.from([1, 2])
  const second = Buffer.from([3, 4])
  player.push(first)
  player.push(second)
  assert.deepEqual(writes, [first])
  callbacks.shift()!()
  await tick()
  assert.deepEqual(Buffer.concat(writes), Buffer.concat([first, second]))
  callbacks.shift()!()
  await player.drain()
})

test("finalizing a SoX response flushes its tail before the next turn", async (t) => {
  const sox = existsSync("/opt/homebrew/bin/sox") ? "/opt/homebrew/bin/sox" : "sox"
  if (spawnSync(sox, ["--version"]).status !== 0) { t.skip("sox is not installed"); return }
  const output: Buffer[] = []
  let spawns = 0
  const args = [
    "-q", "--ignore-length", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-",
    "-t", "raw", "-",
  ]
  const player = new StdinPcmPlayer(() => sox, args, (command, commandArgs) => {
    spawns += 1
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)))
    return child
  })
  t.after(() => player.stop())

  const first = makeSinePcm(440, 2.85)
  await player.start()
  player.push(first)
  await player.drain(true)
  assert.deepEqual(Buffer.concat(output), first)

  const second = makeSinePcm(660, 0.37)
  await player.start()
  player.push(second)
  await player.drain(true)
  assert.equal(spawns, 2)
  assert.deepEqual(Buffer.concat(output), Buffer.concat([first, second]))
})

test("missing speaker executable rejects startup instead of crashing the daemon", async () => {
  const player = new StdinPcmPlayer(() => "/nonexistent/vox-test-player", [])
  try {
    await assert.rejects(player.start(), /ENOENT/)
  } finally { player.stop() }
})

test("unexpected speaker exit is reported once without an infinite restart loop", async () => {
  const player = new StdinPcmPlayer(() => process.execPath, ["-e", "process.exit(2)"])
  const failures: Error[] = []
  player.onError = (error) => failures.push(error)
  try {
    await player.start()
    await until(() => failures.length > 0)
    assert.equal(failures.length, 1)
    assert.match(failures[0].message, /Speaker process exited \(2\)/)
    assert.throws(() => player.push(Buffer.alloc(2)), /Speaker process exited/)
  } finally { player.stop() }
})
