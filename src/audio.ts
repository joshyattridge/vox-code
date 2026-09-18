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
  drainPlayback: (finalize?: boolean) => Promise<void>
  stopPlayback: () => Promise<void>
  restartPlayback: () => Promise<void>
  dispose: () => Promise<void>
  setErrorHandler?: (handler: (error: Error) => void) => void
}

export class AudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AudioError"
  }
}

export const FRAME_MS = 20
export const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000
// WebSocket audio has no media-layer jitter buffer. A small preroll smooths
// packet jitter without making every response feel delayed.
export const PREROLL_MS = 160
export const PREROLL_BYTES = (SAMPLE_RATE * 2 * PREROLL_MS) / 1000
export const UNDERRUN_GAP_MS = 800
const PREROLL_WAIT_MS = PREROLL_MS

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
    // Re-arm after a real delivery gap so a later turn or resumed stream gets
    // jitter protection instead of being written one packet at a time.
    this.markQuiet()
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
  // On macOS Node's child stdin is a socket; fstat can report the currently
  // buffered bytes as its size. SoX must read until EOF, not that first size.
  return ["-q", "--ignore-length", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"]
}

export class StdinPcmPlayer {
  #player?: ChildProcessWithoutNullStreams
  #running = false
  #ready = false
  #corked = false
  #held: Buffer[] = []
  #command: () => string
  #args: string[]
  #failure?: Error
  #starting?: Promise<void>
  #finishing?: ChildProcessWithoutNullStreams
  #endsAt = 0
  #spawnProcess: typeof spawnStdio
  onError?: (error: Error) => void

  constructor(command: () => string, args: string[], spawnProcess = spawnStdio) {
    this.#command = command
    this.#args = args
    this.#spawnProcess = spawnProcess
  }

  start() {
    if (this.#starting) return this.#starting
    if (this.#running && this.#ready) return Promise.resolve()
    this.#running = true
    this.#failure = undefined
    const starting = this.#spawn()
    this.#starting = starting
    void starting.finally(() => {
      if (this.#starting === starting) this.#starting = undefined
    }).catch(() => undefined)
    return starting
  }

  push(pcm: Buffer) {
    if (!pcm.length) return
    if (this.#failure) throw this.#failure
    if (!this.#running) throw new AudioError("Speaker playback is not started")
    const queued = this.#held.reduce((sum, chunk) => sum + chunk.length, 0)
    if (queued + pcm.length > SAMPLE_RATE * 2 * 30) {
      throw new AudioError("Speaker playback stalled: audio queue exceeded 30 seconds")
    }
    this.#write(pcm)
  }

  async drain(finalize = false) {
    const player = this.#player
    const deadline = Date.now() + 35_000
    while (this.#running && player === this.#player && (this.#corked || this.#held.length > 0 || (!finalize && Date.now() < this.#endsAt))) {
      if (Date.now() >= deadline) throw new AudioError("Speaker playback drain timed out")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (this.#failure) throw this.#failure
    if (finalize && player && player === this.#player && this.#running) {
      this.#finishing = player
      this.#ready = false
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AudioError("Speaker playback finalization timed out")), 35_000)
        player.once("exit", (code, signal) => {
          clearTimeout(timer)
          if (code === 0 && !signal) resolve()
          else reject(new AudioError(`Speaker process exited while finalizing (${signal ?? code})`))
        })
        player.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      player.stdin.end()
      try {
        await exited
      } finally {
        if (this.#finishing === player) this.#finishing = undefined
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  stop() {
    this.#running = false
    this.#ready = false
    this.#corked = false
    this.#held = []
    this.#endsAt = 0
    this.#starting = undefined
    this.#finishing = undefined
    const player = this.#player
    this.#player = undefined
    if (!player) return
    try {
      player.stdin.end()
    } catch {
      // already closed
    }
    player.kill("SIGTERM")
    const killer = setTimeout(() => {
      try {
        player.kill("SIGKILL")
      } catch {
        // already gone
      }
    }, 250)
    killer.unref?.()
  }

  #spawn(): Promise<void> {
    const bin = this.#command()
    this.#ready = false
    const child = this.#spawnProcess(bin, this.#args)
    this.#player = child
    voiceLog("player start", { bin, args: this.#args.join(" ") })
    let stderr = ""
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim()
      stderr = (stderr + text).slice(-400)
      if (text) voiceLog("player stderr", text.slice(0, 400))
    })
    return new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        reject(error)
        if (this.#player !== child || !this.#running) return
        this.#failure = error
        this.stop()
        this.onError?.(error)
      }
      child.once("spawn", () => {
        if (this.#player !== child || !this.#running) {
          reject(new AudioError("Speaker startup cancelled"))
          return
        }
        this.#ready = true
        this.#flushHeld()
        resolve()
      })
      child.on("error", fail)
      child.stdin.on("error", (error) => {
        if (this.#finishing !== child) fail(error)
      })
      child.on("exit", (code, signal) => {
        if (this.#finishing === child) {
          if (this.#player === child) this.#player = undefined
          this.#running = false
          this.#ready = false
          this.#corked = false
          this.#endsAt = 0
          return
        }
        fail(new AudioError(`Speaker process exited (${signal ?? code}): ${stderr || bin}`))
      })
    })
  }

  #flushHeld() {
    const held = this.#held.length ? Buffer.concat(this.#held) : undefined
    this.#held = []
    if (held?.length) this.#write(held)
  }

  #write(buf: Buffer) {
    if (!this.#running || !this.#player) return
    if (!this.#ready || this.#corked) {
      this.#held.push(buf)
      return
    }
    let ok = true
    try {
      ok = this.#player.stdin.write(buf)
    } catch (error) {
      throw new AudioError(`Speaker write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.#endsAt = Math.max(Date.now(), this.#endsAt) + pcmDurationMs(buf)
    if (ok) return
    this.#corked = true
    const player = this.#player
    player.stdin.once("drain", () => {
      if (this.#player !== player || !this.#running) return
      this.#corked = false
      this.#flushHeld()
    })
  }
}

class PipedAudio implements AudioIO {
  readonly name: string
  #capture?: ChildProcessWithoutNullStreams
  #playback: StdinPcmPlayer
  #pump = new PcmWritePump()
  #prerollTimer?: ReturnType<typeof setTimeout>
  #recBin: () => string
  #recArgs: string[]
  #played = 0
  #onError?: (error: Error) => void
  #draining?: Promise<void>

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
    if (this.#capture) return
    const child = spawnStdio(this.#recBin(), this.#recArgs)
    this.#capture = child
    let stderr = ""
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-400) })
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#capture === child) onChunk(chunk)
    })
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        reject(error)
        if (this.#capture !== child) return
        this.#capture = undefined
        child.kill("SIGTERM")
        this.#onError?.(error)
      }
      child.once("spawn", resolve)
      child.on("error", fail)
      child.on("exit", (code, signal) => fail(new AudioError(`Microphone process exited (${signal ?? code}): ${stderr || this.#recBin()}`)))
    })
  }

  async stopCapture() {
    this.#capture?.kill("SIGTERM")
    this.#capture = undefined
  }

  async startPlayback() {
    await this.#playback.start()
  }

  setErrorHandler(handler: (error: Error) => void) {
    this.#onError = handler
    this.#playback.onError = handler
  }

  async play(pcm: Buffer) {
    await this.#draining
    this.#played += 1
    if (this.#played <= 3 || this.#played % 40 === 0) {
      voiceLog("play pcm", { n: this.#played, bytes: pcm.length, rms: Math.round(pcmRms(pcm)) })
    }
    const flushed = this.#pump.push(pcm)
    if (flushed) {
      this.#clearPrerollTimer()
      await this.#playback.start()
      this.#playback.push(flushed)
      return
    }
    this.#schedulePrerollFlush()
  }

  async drainPlayback(finalize = false) {
    if (this.#draining) return this.#draining
    const draining = (async () => {
      this.#clearPrerollTimer()
      const held = this.#pump.flushHeld()
      if (held) {
        await this.#playback.start()
        this.#playback.push(held)
      }
      await this.#playback.drain(finalize)
    })()
    this.#draining = draining
    try {
      await draining
    } finally {
      if (this.#draining === draining) this.#draining = undefined
    }
  }

  async stopPlayback() {
    this.#played = 0
    this.#clearPrerollTimer()
    this.#pump.reset()
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

  #schedulePrerollFlush() {
    this.#clearPrerollTimer()
    this.#prerollTimer = setTimeout(async () => {
      this.#prerollTimer = undefined
      const held = this.#pump.flushIfWaited(PREROLL_WAIT_MS)
      if (held) {
        voiceLog("playback preroll timeout", { bytes: held.length })
        try {
          await this.#draining
          await this.#playback.start()
          this.#playback.push(held)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          voiceLog("playback preroll failed", failure.message)
          this.#onError?.(failure)
        }
      }
    }, PREROLL_WAIT_MS)
    this.#prerollTimer.unref?.()
  }

  #clearPrerollTimer() {
    if (!this.#prerollTimer) return
    clearTimeout(this.#prerollTimer)
    this.#prerollTimer = undefined
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

export function pcmDurationMs(pcm: Buffer, rate = SAMPLE_RATE) {
  return Math.ceil((pcm.length / 2 / rate) * 1000)
}

export async function playPcmClip(pcm: Buffer): Promise<void> {
  if (!pcm.length) return
  const play = which("play")
  const ffplay = which("ffplay")
  const aplay = which("aplay")
  const spec = play
    ? { cmd: play, args: soxPlayArgs() }
    : ffplay
      ? { cmd: ffplay, args: ffplayArgs() }
      : aplay
        ? { cmd: aplay, args: aplayArgs }
        : undefined
  if (!spec) {
    throw new AudioError("No speaker tool found. Install sox (play) or ffmpeg (ffplay) to hear voice samples.")
  }
  const child = spawnStdio(spec.cmd, spec.args)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new AudioError("Voice sample playback timed out"))
    }, pcmDurationMs(pcm) + 4000)
    let settled = false
    const done = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.once("error", (error) => done(error instanceof Error ? error : new Error(String(error))))
    child.once("exit", (code, signal) => done(code === 0 && !signal ? undefined : new AudioError(`Voice sample playback failed (${signal ?? code})`)))
    child.stdin.once("error", () => {
      // sox/ffplay may close stdin after the clip; ignore EPIPE
    })
    try {
      child.stdin.end(pcm)
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
    }
  })
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
