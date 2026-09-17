import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { createConnection, type Socket } from "node:net"
import { fileURLToPath } from "node:url"
import { voiceLog, voiceLogPath } from "./log.ts"
import { daemonPidPath, daemonSockPath, readPersistedVoiceState } from "./persist.ts"
import {
  encodeMessage,
  splitMessages,
  VOICE_PROTOCOL,
  type ClientConfig,
  type DownMessage,
  type UpMessage,
} from "./protocol.ts"
import type { SessionClient } from "./client.ts"
import { dispatchSessionOp } from "./http-client.ts"
import type { VoiceSupervisor } from "./supervisor.ts"
import { chipLabel, initialVoiceState, resolveOptions, type VoiceUiState } from "./types.ts"

export type VoiceBridgeHooks = {
  toast?: (input: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  focusSession?: (sessionId: string, directory?: string) => boolean | Promise<boolean>
  onModelChange?: (model: string) => void
  onVoiceChange?: (voice: string) => void
  onInstructionsChange?: (instructions?: string) => void
}

function daemonFile() {
  return fileURLToPath(new URL("./daemon.ts", import.meta.url))
}

const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".bun/bin"),
]

export function isJsRuntime(execPath: string) {
  const name = basename(execPath).toLowerCase()
  return name === "node" || name === "node.exe" || name === "bun" || name === "bun.exe" || name === "deno"
}

function findBinary(name: string, pathEnv: string) {
  const dirs = [...pathEnv.split(delimiter).filter(Boolean), ...EXTRA_BIN_DIRS]
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function resolveDaemonRuntime(input?: { execPath?: string; path?: string }) {
  const execPath = input?.execPath ?? process.execPath
  const pathEnv = input?.path ?? process.env.PATH ?? ""
  if (isJsRuntime(execPath)) {
    const name = basename(execPath).toLowerCase()
    return { cmd: execPath, kind: name.startsWith("bun") ? ("bun" as const) : ("node" as const) }
  }
  const bun = findBinary("bun", pathEnv)
  const node = findBinary("node", pathEnv)
  if (node) return { cmd: node, kind: "node" as const }
  if (bun) return { cmd: bun, kind: "bun" as const }
  throw new Error(
    "Vox Code daemon needs Node.js or Bun on PATH. OpenCode cannot run the daemon script itself.",
  )
}

export function daemonSpawnArgs(
  file = daemonFile(),
  runtime: { cmd: string; kind: "bun" | "node" } = resolveDaemonRuntime(),
) {
  if (runtime.kind === "bun") return { cmd: runtime.cmd, args: [file] }
  return { cmd: runtime.cmd, args: ["--experimental-strip-types", "--no-warnings", file] }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function connectSock(sockPath: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ path: sockPath })
    const onError = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.once("error", onError)
    socket.once("connect", () => {
      socket.off("error", onError)
      resolve(socket)
    })
  })
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnDaemon(sockPath: string) {
  mkdirSync(dirname(sockPath), { recursive: true })
  mkdirSync(dirname(voiceLogPath()), { recursive: true })
  const { cmd, args } = daemonSpawnArgs()
  const logFd = openSync(voiceLogPath(), "a")
  const child = spawn(cmd, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      VOICE_DAEMON: "1",
      VOX_SOCK: sockPath,
      VOICE_SOCK: sockPath,
    },
  })
  child.on("error", (error) => {
    try {
      closeSync(logFd)
    } catch {
      // already closed
    }
    voiceLog("spawn error", error.message)
  })
  child.once("spawn", () => {
    try {
      closeSync(logFd)
    } catch {
      // child holds the log
    }
  })
  child.on("exit", (code, signal) => {
    voiceLog("daemon exit", { code, signal, pid: child.pid })
  })
  child.unref()
  voiceLog("spawn daemon", { pid: child.pid, cmd, args })
}

async function stopDaemonProcess(sockPath: string, pidPath: string) {
  let pid: number | undefined
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10)
  } catch {
    pid = undefined
  }
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone
    }
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && pidAlive(pid)) await wait(50)
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
  }
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath)
  } catch {
    // already gone
  }
}

async function ensureSocket(sockPath: string, pidPath: string) {
  mkdirSync(dirname(sockPath), { recursive: true })
  try {
    return await connectSock(sockPath)
  } catch {
    // spawn if nothing is listening
  }
  let pid: number | undefined
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10)
  } catch {
    pid = undefined
  }
  if (pid && pidAlive(pid)) {
    voiceLog("stale daemon pid without socket", { pid })
  }
  spawnDaemon(sockPath)
  const deadline = Date.now() + 8000
  let lastError: unknown
  while (Date.now() < deadline) {
    await wait(80)
    try {
      return await connectSock(sockPath)
    } catch (error) {
      lastError = error
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "Vox Code daemon did not start"
  throw new Error(`${detail}. Check ${voiceLogPath()}`)
}

export async function attachVoiceDaemon(input: {
  directory?: string
  options?: Record<string, unknown>
  client?: ClientConfig
  sessionId?: string
  sockPath?: string
  pidPath?: string
  hooks?: VoiceBridgeHooks
  sessionClient?: SessionClient
  connect?: (sockPath: string) => Promise<Socket>
  replaced?: boolean
}): Promise<VoiceSupervisor> {
  const sockPath = input.sockPath ?? process.env.VOX_SOCK ?? process.env.VOICE_SOCK ?? daemonSockPath()
  const pidPath = input.pidPath ?? daemonPidPath()
  const socket = input.connect ? await input.connect(sockPath) : await ensureSocket(sockPath, pidPath)
  socket.setEncoding("utf8")

  const listeners = new Set<() => void>()
  const persisted = readPersistedVoiceState()
  let ui: VoiceUiState = {
    ...initialVoiceState(),
    lastUserTranscript: persisted.lastUserTranscript,
    lastAssistantTranscript: persisted.lastAssistantTranscript,
    ownedSessionIds: persisted.ownedSessionIds ?? [],
  }
  let model = resolveOptions(input.options).model
  let voice = resolveOptions(input.options).voice
  let instructions = resolveOptions(input.options).instructions
  let statusText = `phase: ${ui.phase}`
  let buffer = ""
  let ready = false
  let protocol = 0
  let gotState = false

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const send = (message: UpMessage) => {
    if (!socket.destroyed) socket.write(encodeMessage(message))
  }

  const waitFor = (predicate: () => boolean, ms = 12_000) => {
    if (predicate()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        unsub()
        resolve()
      }, ms)
      const unsub = subscribe(() => {
        if (!predicate()) return
        clearTimeout(timer)
        unsub()
        resolve()
      })
    })
  }

  const handleDown = (message: DownMessage) => {
    switch (message.type) {
      case "ready":
        ready = true
        protocol = message.protocol ?? 0
        notify()
        return
      case "state":
        gotState = true
        if (message.model !== model) input.hooks?.onModelChange?.(message.model)
        if (message.voice !== voice) input.hooks?.onVoiceChange?.(message.voice)
        if (message.instructions !== instructions) input.hooks?.onInstructionsChange?.(message.instructions)
        ui = message.state
        model = message.model
        voice = message.voice
        instructions = message.instructions
        statusText = message.statusText
        notify()
        return
      case "toast":
        input.hooks?.toast?.({ title: "Vox Code", message: message.message, variant: message.variant })
        return
      case "focus":
        void (async () => {
          const focused = Boolean(await input.hooks?.focusSession?.(message.sessionId, message.directory))
          send({ type: "focusResult", sessionId: message.sessionId, focused })
        })()
        return
      case "rpc": {
        void (async () => {
          if (!input.sessionClient) {
            send({ type: "rpcResult", id: message.id, error: { message: "TUI has no OpenCode client" } })
            return
          }
          try {
            const result = await dispatchSessionOp(input.sessionClient, message.op, message.params)
            send({ type: "rpcResult", id: message.id, data: result.data, error: result.error })
          } catch (error) {
            send({
              type: "rpcResult",
              id: message.id,
              error: { message: error instanceof Error ? error.message : String(error) },
            })
          }
        })()
        return
      }
    }
  }

  socket.on("data", (chunk) => {
    const { messages, rest } = splitMessages(buffer + String(chunk))
    buffer = rest
    for (const message of messages) {
      if (!message || typeof message !== "object" || !("type" in message)) continue
      handleDown(message as DownMessage)
    }
  })
  socket.on("error", (error) => {
    voiceLog("bridge socket error", error.message)
  })
  socket.on("close", () => {
    voiceLog("bridge disconnected")
  })

  send({
    type: "hello",
    directory: input.directory,
    options: input.options,
    client: input.client,
    sessionId: input.sessionId,
  })
  await waitFor(() => ready, 4000)
  await waitFor(() => gotState, 2000)
  if (protocol < VOICE_PROTOCOL && !input.replaced && !input.connect) {
    voiceLog("replacing old voice daemon", { protocol })
    socket.end()
    await stopDaemonProcess(sockPath, pidPath)
    return attachVoiceDaemon({ ...input, replaced: true, connect: undefined })
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const supervisor: VoiceSupervisor = {
    state: () => ui,
    model: () => model,
    voice: () => voice,
    instructions: () => instructions,
    chip: () => chipLabel(ui),
    subscribe,
    async start() {
      send({ type: "start" })
      await waitFor(() => ["connected", "listening", "speaking", "error"].includes(ui.phase))
    },
    async stop(opts) {
      send({ type: "stop", silent: opts?.silent })
      await waitFor(() => ui.phase === "off")
    },
    async toggle() {
      send({ type: "toggle" })
      const wasOff = ui.phase === "off" || ui.phase === "error"
      await waitFor(() => (wasOff ? ui.phase !== "off" && ui.phase !== "connecting" : ui.phase === "off"))
    },
    async setModel(next) {
      send({ type: "setModel", model: next })
      await waitFor(() => model === next.trim())
    },
    async setVoice(next) {
      send({ type: "setVoice", voice: next })
      await waitFor(() => voice === next.trim())
    },
    async setInstructions(next) {
      send({ type: "setInstructions", instructions: next })
      const expected = next?.trim() || undefined
      await waitFor(() => (instructions?.trim() || undefined) === expected)
    },
    async previewVoice(next) {
      send({ type: "previewVoice", voice: next })
    },
    statusText: () => statusText,
    handleIdle(sessionId) {
      send({ type: "idle", sessionId })
    },
    handleError(sessionId, message) {
      send({ type: "sessionError", sessionId, message })
    },
    handlePermission(sessionId, permissionId, title) {
      send({ type: "permission", sessionId, permissionId, title })
    },
    async rebindAudio(reason = "session") {
      voiceLog("rebind skipped", reason)
    },
    setCurrentSession(sessionId) {
      send({ type: "currentSession", sessionId })
    },
    async dispose() {
      voiceLog("tui disconnect keep-alive")
      listeners.clear()
      socket.end()
    },
  }

  return supervisor
}
