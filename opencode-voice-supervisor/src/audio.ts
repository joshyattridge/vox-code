import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { SAMPLE_RATE } from "./types.ts"

export type AudioHandler = (chunk: Buffer) => void

export type AudioIO = {
  readonly name: string
  startCapture: (onChunk: AudioHandler) => Promise<void>
  stopCapture: () => Promise<void>
  play: (pcm: Buffer) => Promise<void>
  stopPlayback: () => Promise<void>
  dispose: () => Promise<void>
}

export class AudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AudioError"
  }
}

function which(bin: string): string | undefined {
  const path = process.env.PATH ?? ""
  for (const dir of path.split(":")) {
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

class SoxAudio implements AudioIO {
  readonly name = "sox"
  #capture?: ChildProcessWithoutNullStreams
  #player?: ChildProcessWithoutNullStreams

  async startCapture(onChunk: AudioHandler) {
    const rec = which("rec")
    if (!rec) throw new AudioError("sox rec is not installed")
    this.#capture = spawnStdio(rec, ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"])
    this.#capture.stdout.on("data", (chunk: Buffer) => onChunk(chunk))
    this.#capture.on("error", (error) => {
      throw new AudioError(`rec failed: ${error.message}`)
    })
  }

  async stopCapture() {
    this.#capture?.kill("SIGTERM")
    this.#capture = undefined
  }

  async play(pcm: Buffer) {
    if (!this.#player || this.#player.killed) {
      const play = which("play")
      if (!play) throw new AudioError("sox play is not installed")
      this.#player = spawnStdio(play, ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"])
    }
    this.#player.stdin.write(pcm)
  }

  async stopPlayback() {
    if (!this.#player) return
    try {
      this.#player.stdin.end()
    } catch {
      // already closed
    }
    this.#player.kill("SIGTERM")
    this.#player = undefined
  }

  async dispose() {
    await this.stopCapture()
    await this.stopPlayback()
  }
}

class AlsaAudio implements AudioIO {
  readonly name = "alsa"
  #capture?: ChildProcessWithoutNullStreams
  #player?: ChildProcessWithoutNullStreams

  async startCapture(onChunk: AudioHandler) {
    const arecord = which("arecord")
    if (!arecord) throw new AudioError("arecord is not installed")
    this.#capture = spawnStdio(arecord, ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"])
    this.#capture.stdout.on("data", (chunk: Buffer) => onChunk(chunk))
  }

  async stopCapture() {
    this.#capture?.kill("SIGTERM")
    this.#capture = undefined
  }

  async play(pcm: Buffer) {
    if (!this.#player || this.#player.killed) {
      const aplay = which("aplay")
      if (!aplay) throw new AudioError("aplay is not installed")
      this.#player = spawnStdio(aplay, ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"])
    }
    this.#player.stdin.write(pcm)
  }

  async stopPlayback() {
    this.#player?.kill("SIGTERM")
    this.#player = undefined
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

  async play(pcm: Buffer) {
    this.played.push(pcm)
  }

  async stopPlayback() {
    this.played.length = 0
  }

  async dispose() {
    this.capturing = false
    this.#onChunk = undefined
  }
}

export function detectAudio(): AudioIO {
  if (which("rec") && which("play")) return new SoxAudio()
  if (which("arecord") && which("aplay")) return new AlsaAudio()
  if (which("rec") || which("arecord")) {
    // capture-only is still better than nothing; playback may fail later
    if (which("rec")) return new SoxAudio()
    return new AlsaAudio()
  }
  throw new AudioError(
    "No microphone tools found. Install sox (rec/play) or alsa-utils (arecord/aplay) on this machine.",
  )
}

export function describeAudioDeps(): string[] {
  const found: string[] = []
  for (const bin of ["rec", "play", "arecord", "aplay"]) {
    if (which(bin)) found.push(bin)
  }
  return found
}
