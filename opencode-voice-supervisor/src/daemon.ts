import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHttpSessionClient, createRpcSessionClient, createSessionClientProxy } from "./http-client.ts"
import { voiceLog } from "./log.ts"
import { daemonPidPath, daemonSockPath } from "./persist.ts"
import {
  encodeMessage,
  splitMessages,
  VOICE_PROTOCOL,
  type ClientConfig,
  type DownMessage,
  type UpMessage,
} from "./protocol.ts"
import { createVoiceSupervisor, type VoiceSupervisor } from "./supervisor.ts"
import { initialVoiceState, resolveOptions, type VoiceUiState } from "./types.ts"

export type VoiceDaemon = {
  sockPath: string
  close: () => Promise<void>
}

export type DaemonSupervisorFactory = (input: {
  client: ReturnType<typeof createSessionClientProxy>
  directory: () => string | undefined
  options: Record<string, unknown>
  currentSessionId: () => string | undefined
  toast: (input: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  focusSession: (sessionId: string, directory?: string) => boolean | Promise<boolean>
}) => VoiceSupervisor

const IDLE_EXIT_MS = 15_000

function isUpMessage(value: unknown): value is UpMessage {
  return Boolean(
    value && typeof value === "object" && "type" in value && typeof (value as { type: unknown }).type === "string",
  )
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(pidPath: string) {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

export async function listenVoiceDaemon(input?: {
  sockPath?: string
  pidPath?: string
  createSupervisor?: DaemonSupervisorFactory
  idleExitMs?: number
  installSignals?: boolean
}): Promise<VoiceDaemon> {
  const sockPath = input?.sockPath ?? process.env.VOICE_SOCK ?? daemonSockPath()
  const pidPath = input?.pidPath ?? daemonPidPath()
  const idleExitMs = input?.idleExitMs ?? IDLE_EXIT_MS
  mkdirSync(dirname(sockPath), { recursive: true })

  const sockets = new Set<Socket>()
  const buffers = new WeakMap<Socket, string>()
  const pendingRpc = new Map<
    string,
    { resolve: (value: { data?: unknown; error?: unknown }) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const pendingFocus = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const clientProxy = createSessionClientProxy(createHttpSessionClient({}))
  let httpConfig: ClientConfig = {}
  let directory: string | undefined
  let currentSessionId: string | undefined
  let options: Record<string, unknown> = {}
  let supervisor: VoiceSupervisor | undefined
  let idleExit: ReturnType<typeof setTimeout> | undefined
  let unsub: (() => void) | undefined
  let closed = false
  let commandQueue = Promise.resolve()

  const broadcast = (message: DownMessage) => {
    const payload = encodeMessage(message)
    for (const socket of sockets) {
      if (!socket.destroyed) socket.write(payload)
    }
  }

  const failPendingRpc = (message: string) => {
    for (const [id, waiter] of pendingRpc) {
      clearTimeout(waiter.timer)
      waiter.resolve({ error: { message } })
      pendingRpc.delete(id)
    }
    for (const [id, waiter] of pendingFocus) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
      pendingFocus.delete(id)
    }
  }

  const requestFocus = (sessionId: string, focusDirectory?: string) =>
    new Promise<boolean>((resolve) => {
      if (sockets.size === 0) {
        resolve(false)
        return
      }
      const previous = pendingFocus.get(sessionId)
      if (previous) {
        clearTimeout(previous.timer)
        previous.resolve(false)
        pendingFocus.delete(sessionId)
      }
      const timer = setTimeout(() => {
        if (!pendingFocus.delete(sessionId)) return
        resolve(false)
      }, 4000)
      pendingFocus.set(sessionId, { resolve, timer })
      broadcast({ type: "focus", sessionId, directory: focusDirectory })
    })

  const rpcRequest = (op: string, params?: unknown) =>
    new Promise<{ data?: unknown; error?: unknown }>((resolve) => {
      const target = sockets.values().next().value as Socket | undefined
      if (!target || target.destroyed) {
        resolve({ error: { message: "Voice daemon has no TUI client" } })
        return
      }
      const id = randomUUID()
      const timer = setTimeout(() => {
        if (!pendingRpc.delete(id)) return
        resolve({ error: { message: "TUI RPC timed out" } })
      }, 20_000)
      pendingRpc.set(id, { resolve, timer })
      target.write(encodeMessage({ type: "rpc", id, op, params } satisfies DownMessage))
    })

  const refreshClient = () => {
    if (sockets.size > 0) {
      clientProxy.replace(createRpcSessionClient(rpcRequest))
      return
    }
    clientProxy.replace(createHttpSessionClient(httpConfig))
  }

  const snapshot = (): Extract<DownMessage, { type: "state" }> => {
    const state: VoiceUiState = supervisor?.state() ?? initialVoiceState()
    const resolved = resolveOptions(options)
    return {
      type: "state",
      state,
      model: supervisor?.model() ?? resolved.model,
      voice: supervisor?.voice() ?? resolved.voice,
      instructions: supervisor?.instructions(),
      statusText: supervisor?.statusText() ?? `phase: ${state.phase}`,
    }
  }

  const scheduleIdleExit = () => {
    if (idleExit) clearTimeout(idleExit)
    idleExit = undefined
    const live = supervisor?.state().realtimeConnected || supervisor?.state().phase === "connecting"
    if (live || sockets.size > 0 || closed) return
    idleExit = setTimeout(() => {
      if (sockets.size > 0 || closed) return
      const stillLive = supervisor?.state().realtimeConnected || supervisor?.state().phase === "connecting"
      if (stillLive) return
      void close()
    }, idleExitMs)
  }

  const ensureSupervisor = () => {
    if (supervisor) return supervisor
    const factory = input?.createSupervisor
    supervisor = factory
      ? factory({
          client: clientProxy,
          directory: () => directory,
          options,
          currentSessionId: () => currentSessionId,
          toast: (toast) => broadcast({ type: "toast", message: toast.message, variant: toast.variant }),
          focusSession: async (sessionId, focusDirectory) => requestFocus(sessionId, focusDirectory),
        })
      : createVoiceSupervisor({
          client: clientProxy,
          directory: () => directory,
          options,
          hooks: {
            currentSessionId: () => currentSessionId,
            toast: (toast) => broadcast({ type: "toast", message: toast.message, variant: toast.variant }),
            focusSession: async (sessionId, focusDirectory) => requestFocus(sessionId, focusDirectory),
          },
        })
    unsub = supervisor.subscribe(() => broadcast(snapshot()))
    return supervisor
  }

  const handle = async (socket: Socket, message: UpMessage) => {
    switch (message.type) {
      case "hello": {
        if (message.directory) directory = message.directory
        if (message.sessionId !== undefined) currentSessionId = message.sessionId
        if (message.options) options = { ...options, ...message.options }
        if (message.client) httpConfig = message.client
        refreshClient()
        const voice = ensureSupervisor()
        const resolved = resolveOptions(message.options)
        if (voice.state().phase === "off") {
          if (resolved.model && resolved.model !== voice.model()) {
            await voice.setModel(resolved.model)
          }
          if (resolved.voice && resolved.voice !== voice.voice()) {
            await voice.setVoice(resolved.voice)
          }
          const nextInstructions = resolved.instructions?.trim() || undefined
          const currentInstructions = voice.instructions()?.trim() || undefined
          if (nextInstructions !== currentInstructions) {
            await voice.setInstructions(nextInstructions)
          }
        }
        socket.write(encodeMessage({ type: "ready", protocol: VOICE_PROTOCOL } satisfies DownMessage))
        socket.write(encodeMessage(snapshot()))
        voiceLog("daemon hello", {
          directory,
          clients: sockets.size,
          phase: voice.state().phase,
          baseUrl: httpConfig.baseUrl ?? null,
          rpc: true,
        })
        return
      }
      case "rpcResult": {
        const waiter = pendingRpc.get(message.id)
        if (!waiter) return
        pendingRpc.delete(message.id)
        clearTimeout(waiter.timer)
        waiter.resolve({ data: message.data, error: message.error })
        return
      }
      case "start":
        await ensureSupervisor().start()
        return
      case "stop":
        await ensureSupervisor().stop({ silent: message.silent })
        scheduleIdleExit()
        return
      case "toggle":
        await ensureSupervisor().toggle()
        scheduleIdleExit()
        return
      case "setModel":
        await ensureSupervisor().setModel(message.model)
        return
      case "setVoice":
        await ensureSupervisor().setVoice(message.voice)
        return
      case "setInstructions":
        await ensureSupervisor().setInstructions(message.instructions)
        return
      case "previewVoice":
        await ensureSupervisor().previewVoice(message.voice)
        return
      case "idle":
        ensureSupervisor().handleIdle(message.sessionId)
        return
      case "sessionError":
        ensureSupervisor().handleError(message.sessionId, message.message)
        return
      case "permission":
        ensureSupervisor().handlePermission(message.sessionId, message.permissionId, message.title)
        return
      case "currentSession":
        currentSessionId = message.sessionId
        return
      case "focusResult": {
        const waiter = pendingFocus.get(message.sessionId)
        if (!waiter) return
        pendingFocus.delete(message.sessionId)
        clearTimeout(waiter.timer)
        waiter.resolve(Boolean(message.focused))
        return
      }
    }
  }

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    buffers.set(socket, "")
    if (idleExit) {
      clearTimeout(idleExit)
      idleExit = undefined
    }
    voiceLog("daemon client connected", { clients: sockets.size })
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      const previous = buffers.get(socket) ?? ""
      const { messages, rest } = splitMessages(previous + String(chunk))
      buffers.set(socket, rest)
      for (const message of messages) {
        if (!isUpMessage(message)) continue
        commandQueue = commandQueue.then(() =>
          handle(socket, message).catch((error) => {
            voiceLog("daemon command failed", error instanceof Error ? error.message : String(error))
          }),
        )
      }
    })
    socket.on("close", () => {
      sockets.delete(socket)
      if (sockets.size === 0) failPendingRpc("TUI disconnected")
      refreshClient()
      voiceLog("daemon client gone", { clients: sockets.size, phase: supervisor?.state().phase })
      scheduleIdleExit()
    })
    socket.on("error", () => {
      sockets.delete(socket)
    })
  })

  const close = async () => {
    if (closed) return
    closed = true
    if (idleExit) clearTimeout(idleExit)
    failPendingRpc("Voice daemon stopped")
    unsub?.()
    await supervisor?.stop({ silent: true }).catch(() => undefined)
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const owned = readPid(pidPath)
    if (owned === process.pid) {
      try {
        if (existsSync(sockPath)) unlinkSync(sockPath)
      } catch {
        // already gone
      }
      try {
        if (existsSync(pidPath)) unlinkSync(pidPath)
      } catch {
        // already gone
      }
    }
    voiceLog("daemon stopped")
  }

  const bind = () =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("error", onError)
        reject(error)
      }
      server.once("error", onError)
      server.listen(sockPath, () => {
        server.off("error", onError)
        resolve()
      })
    })

  try {
    await bind()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EADDRINUSE") throw error
    const existing = readPid(pidPath)
    if (existing && pidAlive(existing)) {
      throw new Error(`Voice daemon already running (pid ${existing})`)
    }
    try {
      unlinkSync(sockPath)
    } catch {
      // continue
    }
    await bind()
  }

  try {
    writeFileSync(pidPath, `${process.pid}\n`)
  } catch {
    // pid file is diagnostic only
  }
  voiceLog("daemon listening", { sockPath, pid: process.pid })

  if (input?.installSignals) {
    const onSignal = () => {
      void close().finally(() => process.exit(0))
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }

  return { sockPath, close }
}

export async function runVoiceDaemon() {
  await listenVoiceDaemon({ installSignals: true })
  await new Promise(() => undefined)
}

function isDaemonEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (process.env.VOICE_DAEMON === "1" && isDaemonEntrypoint()) {
  void runVoiceDaemon().catch((error) => {
    voiceLog("daemon failed", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
