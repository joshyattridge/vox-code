import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { voiceLog } from "./log.ts"
import { SAMPLE_RATE } from "./types.ts"

export type AudioHandler = (chunk: Buffer) => void

export type AudioIO = {
  readonly name: string
  startCapture: (onChunk: AudioHandler) => Promise<void>
  stopCapture: () => Promise<void>
  startPlayback: () => Promise<void>
  play: (pcm: Buffer) => Promise<void>
  drainPlayback: () => Promise<void>
  stopPlayback: () => Promise<void>
  restartPlayback: () => Promise<void>
  dispose: () => Promise<void>
}

export class AudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AudioError"
  }
}

export const FRAME_MS = 20
export const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000
export const PREROLL_MS = 0
export const PREROLL_BYTES = (SAMPLE_RATE * 2 * PREROLL_MS) / 1000
export const UNDERRUN_GAP_MS = 800

const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]

function which(bin: string): string | undefined {
  const dirs = new Set(
    [...(process.env.PATH ?? "").split(":"), ...EXTRA_BIN_DIRS].filter(Boolean),
  )
  for (const dir of dirs) {
    const candidate = `${dir}/${bin}`
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function spawnStdio(command: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
  child.stderr?.setEncoding("utf8")
  return child
}

export class PcmWritePump {
  queuedBytes = 0
  flushing = false
  #chunks: Buffer[] = []
  #lastPush = 0
  prerollBytes: number
  gapMs: number
  now: () => number

  constructor(prerollBytes = PREROLL_BYTES, gapMs = UNDERRUN_GAP_MS, now: () => number = Date.now) {
    this.prerollBytes = prerollBytes
    this.gapMs = gapMs
    this.now = now
  }

  push(pcm: Buffer): Buffer | undefined {
    if (!pcm.length) return
    this.#chunks.push(pcm)
    this.queuedBytes += pcm.length
    this.#lastPush = this.now()
    if (!this.flushing && this.queuedBytes < this.prerollBytes) return
    this.flushing = true
    return this.#takeAll()
  }

  /** Play held preroll so short replies are not stuck behind silence. */
  flushHeld(): Buffer | undefined {
    if (!this.queuedBytes) return
    this.flushing = true
    this.#lastPush = this.now()
    return this.#takeAll()
  }

  /** Start playback if packets stalled before the jitter buffer filled. */
  flushIfWaited(waitMs: number): Buffer | undefined {
    if (this.flushing || !this.queuedBytes) return
    if (this.now() - this.#lastPush < waitMs) return
    return this.flushHeld()
  }

  markQuiet() {
    if (this.flushing && this.queuedBytes === 0 && this.now() - this.#lastPush >= this.gapMs) {
      this.flushing = false
    }
  }

  reset() {
    this.#chunks = []
    this.queuedBytes = 0
    this.flushing = false
    this.#lastPush = 0
  }

  #takeAll() {
    const buf = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks)
    this.#chunks = []
    this.queuedBytes = 0
    return buf
  }
}

export function ffplayArgs() {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nodisp",
    "-autoexit",
    "-f",
    "s16le",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-i",
    "pipe:0",
  ]
}

export function soxPlayArgs() {
  return ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"]
}

class StdinPcmPlayer {
  #player?: ChildProcessWithoutNullStreams
  #running = false
  #ready = false
  #corked = false
  #held: Buffer[] = []
  #command: () => string
  #args: string[]
  restarts = 0

  constructor(command: () => string, args: string[]) {
    this.#command = command
    this.#args = args
  }

  start() {
    if (this.#running && this.#player && !this.#player.killed) return
    this.#running = true
    this.#spawn()
  }

  push(pcm: Buffer) {
    if (!pcm.length) return
    if (!this.#running) this.start()
    this.#write(pcm)
  }

  async drain() {
    const deadline = Date.now() + 1500
    while (Date.now() < deadline && (this.#corked || this.#held.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  stop() {
    this.#running = false
    this.#ready = false
    this.#corked = false
    this.#held = []
    if (!this.#player) return
    try {
      this.#player.stdin.end()
    } catch {
      // already closed
    }
    this.#player.kill("SIGTERM")
    this.#player = undefined
  }

  #spawn() {
    if (this.#player && !this.#player.killed) return
    const bin = this.#command()
    this.#ready = false
    this.#player = spawnStdio(bin, this.#args)
    voiceLog("player start", { bin, args: this.#args.join(" ") })
    this.#player.once("spawn", () => {
      this.#ready = true
      this.#flushHeld()
    })
    this.#player.stdin.on("error", (error) => {
      voiceLog("player stdin error", error.message)
      this.#player = undefined
      this.#ready = false
      if (this.#running) this.#spawn()
    })
    this.#player.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim()
      if (text) voiceLog("player stderr", text.slice(0, 400))
    })
    this.#player.on("exit", (code, signal) => {
      this.#player = undefined
      this.#ready = false
      if (!this.#running) return
      this.restarts += 1
      voiceLog("player restart", { name: bin, code, signal, restarts: this.restarts })
      this.#spawn()
    })
  }

  #flushHeld() {
    const held = this.#held.length ? Buffer.concat(this.#held) : undefined
    this.#held = []
    if (held?.length) this.#write(held)
  }

  #write(buf: Buffer) {
    if (!this.#player || this.#player.killed) this.#spawn()
    if (!this.#player) return
    if (!this.#ready || this.#corked) {
      this.#held.push(buf)
      return
    }
    let ok = true
    try {
      ok = this.#player.stdin.write(buf)
    } catch (error) {
      voiceLog("player write failed", error instanceof Error ? error.message : String(error))
      this.#player = undefined
      this.#ready = false
      if (this.#running) this.#spawn()
      return
    }
    if (ok) return
    this.#corked = true
    const player = this.#player
    player.stdin.once("drain", () => {
      this.#corked = false
      this.#flushHeld()
    })
  }
}

class PipedAudio implements AudioIO {
  readonly name: string
  #capture?: ChildProcessWithoutNullStreams
  #playback: StdinPcmPlayer
  #recBin: () => string
  #recArgs: string[]
  #played = 0

  constructor(
    name: string,
    recBin: () => string,
    recArgs: string[],
    playBin: () => string,
    playArgs: string[],
  ) {
    this.name = name
    this.#recBin = recBin
    this.#recArgs = recArgs
    this.#playback = new StdinPcmPlayer(playBin, playArgs)
  }

  async startCapture(onChunk: AudioHandler) {
    this.#capture = spawnStdio(this.#recBin(), this.#recArgs)
    this.#capture.stdout.on("data", (chunk: Buffer) => onChunk(chunk))
    this.#capture.on("error", () => undefined)
  }

  async stopCapture() {
    this.#capture?.kill("SIGTERM")
    this.#capture = undefined
  }

  async startPlayback() {
    this.#playback.start()
  }

  async play(pcm: Buffer) {
    this.#played += 1
    if (this.#played <= 3 || this.#played % 40 === 0) {
      voiceLog("play pcm", { n: this.#played, bytes: pcm.length, rms: Math.round(pcmRms(pcm)) })
    }
    this.#playback.push(pcm)
  }

  async drainPlayback() {
    await this.#playback.drain()
  }

  async stopPlayback() {
    this.#played = 0
    this.#playback.stop()
  }

  async restartPlayback() {
    await this.stopPlayback()
    await this.startPlayback()
  }

  async dispose() {
    await this.stopCapture()
    await this.stopPlayback()
  }
}

export class MemoryAudio implements AudioIO {
  readonly name = "memory"
  readonly captured: Buffer[] = []
  readonly played: Buffer[] = []
  #onChunk?: AudioHandler
  capturing = false

  async startCapture(onChunk: AudioHandler) {
    this.#onChunk = onChunk
    this.capturing = true
  }

  push(chunk: Buffer) {
    this.captured.push(chunk)
    if (this.capturing) this.#onChunk?.(chunk)
  }

  async stopCapture() {
    this.capturing = false
  }

  async startPlayback() {}

  async play(pcm: Buffer) {
    this.played.push(pcm)
  }

  async drainPlayback() {}

  async stopPlayback() {
    this.played.length = 0
  }

  async restartPlayback() {}

  async dispose() {
    this.capturing = false
    this.#onChunk = undefined
  }
}

const recArgs = ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"]
const arecordArgs = ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"]
const aplayArgs = ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "-B", "500000"]

export function detectAudio(): AudioIO {
  const rec = which("rec")
  const ffplay = which("ffplay")
  const play = which("play")
  const arecord = which("arecord")
  const aplay = which("aplay")

  if (rec && play) {
    return new PipedAudio("sox", () => rec, recArgs, () => play, soxPlayArgs())
  }
  if (rec && ffplay) {
    return new PipedAudio(
      "ffplay",
      () => rec,
      recArgs,
      () => ffplay,
      ffplayArgs(),
    )
  }
  if (arecord && aplay) {
    return new PipedAudio("alsa", () => arecord, arecordArgs, () => aplay, aplayArgs)
  }
  if (rec || arecord) {
    if (rec && play) return new PipedAudio("sox", () => rec, recArgs, () => play, soxPlayArgs())
    if (rec) throw new AudioError("Found rec but no play/ffplay for speakers.")
    throw new AudioError("Found arecord but no aplay for speakers.")
  }
  throw new AudioError(
    "No microphone tools found. Install sox (rec/play) or alsa-utils (arecord/aplay) on this machine.",
  )
}

export function describeAudioDeps(): string[] {
  const found: string[] = []
  for (const bin of ["rec", "play", "ffplay", "arecord", "aplay"]) {
    if (which(bin)) found.push(bin)
  }
  return found
}

export function pcmRms(pcm: Buffer) {
  const samples = Math.floor(pcm.length / 2)
  if (samples <= 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2)
    sum += sample * sample
  }
  return Math.sqrt(sum / samples)
}

export function makeSinePcm(hz: number, seconds: number, rate = SAMPLE_RATE, amplitude = 8000): Buffer {
  const samples = Math.floor(rate * seconds)
  const out = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate))
    out.writeInt16LE(value, i * 2)
  }
  return out
}
