import assert from "node:assert/strict"
import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { test } from "node:test"
import { attachVoiceDaemon, daemonSpawnArgs, isJsRuntime, resolveDaemonRuntime } from "../src/bridge.ts"
import type { SessionClient } from "../src/client.ts"
import { listenVoiceDaemon } from "../src/daemon.ts"
import type { VoiceSupervisor } from "../src/supervisor.ts"
import { chipLabel, initialVoiceState, type VoiceUiState } from "../src/types.ts"
import { until } from "./helpers.ts"

function fakeSupervisor(savedKeys?: string[]): VoiceSupervisor {
  let state: VoiceUiState = initialVoiceState()
  let model = "gpt-realtime"
  let voice = "marin"
  let instructions: string | undefined
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const start = async () => {
    state = { ...state, phase: "connected", realtimeConnected: true, desiredOn: true }
    notify()
  }
  const stop = async () => {
    state = initialVoiceState()
    notify()
  }
  return {
    state: () => state,
    model: () => model,
    voice: () => voice,
    instructions: () => instructions,
    chip: () => chipLabel(state),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    stop,
    async toggle() {
      if (state.phase === "off" || state.phase === "error") await start()
      else await stop()
    },
    async setModel(next) {
      model = next.trim()
      notify()
    },
    async setVoice(next) {
      voice = next.trim()
      notify()
    },
    async setInstructions(next) {
      instructions = next?.trim() || undefined
      notify()
    },
    async setApiKey(apiKey) {
      savedKeys?.push(apiKey)
    },
    async removeApiKey() {},
    async previewVoice() {},
    statusText: () => `phase: ${state.phase}`,
    handleIdle() {},
    handleError() {},
    handlePermission() {},
    async rebindAudio() {},
    setCurrentSession() {},
    async dispose() {
      await stop()
      listeners.clear()
    },
  }
}

test("TUI disconnect leaves the background voice daemon running", async () => {
  const id = `${process.pid}-${Date.now()}`
  const sockPath = join(tmpdir(), `vox-voice-${id}.sock`)
  const pidPath = join(tmpdir(), `vox-voice-${id}.pid`)
  const inner = fakeSupervisor()
  const savedKeys: string[] = []
  const focused: Array<{ sessionId: string; directory?: string }> = []
  let focusFromDaemon: ((sessionId: string, directory?: string) => boolean | Promise<boolean>) | undefined
  let currentContextFromDaemon: (() => Promise<unknown>) | undefined

  const daemon = await listenVoiceDaemon({
    sockPath,
    pidPath,
    idleExitMs: 60_000,
    createSupervisor: (input) => {
      focusFromDaemon = input.focusSession
      currentContextFromDaemon = input.currentContext
      return {
        ...inner,
        setApiKey: async (apiKey) => {
          savedKeys.push(apiKey)
        },
      }
    },
  })

  try {
    const bridge = await attachVoiceDaemon({
      sockPath,
      pidPath,
      options: { model: "gpt-live-1" },
      hooks: {
        currentContext: () => ({ route: { name: "session", sessionID: "ses_current" } }),
        focusSession: async (sessionId, directory) => {
          focused.push({ sessionId, directory })
          return true
        },
      },
    })
    await bridge.start()
    assert.equal(bridge.state().phase, "connected")
    assert.equal(inner.state().phase, "connected")

    await bridge.setVoice("cedar")
    assert.equal(bridge.voice(), "cedar")
    assert.equal(inner.voice(), "cedar")
    await bridge.setInstructions("Talk like a calm coach.")
    assert.match(bridge.instructions() ?? "", /calm coach/)
    assert.match(inner.instructions() ?? "", /calm coach/)
    await bridge.setApiKey("sk-vox-only")
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(savedKeys, ["sk-vox-only"])

    await focusFromDaemon?.("ses_worker", "/tmp/mario-game")
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(focused, [{ sessionId: "ses_worker", directory: "/tmp/mario-game" }])

    assert.deepEqual(await currentContextFromDaemon?.(), {
      route: { name: "session", sessionID: "ses_current" },
    })

    await bridge.dispose()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(inner.state().phase, "connected")
    assert.equal(inner.state().realtimeConnected, true)

    const again = await attachVoiceDaemon({ sockPath, pidPath })
    assert.equal(again.state().phase, "connected")
    await again.dispose()
  } finally {
    await daemon.close()
    try {
      unlinkSync(sockPath)
    } catch {
      // already removed
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // already removed
    }
  }
})

test("daemon spawn uses Node or Bun, not the OpenCode CLI", () => {
  assert.equal(isJsRuntime("/Users/me/.opencode/bin/opencode"), false)
  assert.equal(isJsRuntime("/usr/local/bin/node"), true)
  assert.equal(isJsRuntime("/opt/homebrew/bin/bun"), true)
  const runtime = resolveDaemonRuntime({
    execPath: "/Users/me/.opencode/bin/opencode",
    path: process.env.PATH,
  })
  assert.match(runtime.cmd, /node|bun/)
  assert.notEqual(basename(runtime.cmd), "opencode")
  const spawned = daemonSpawnArgs("/tmp/daemon.ts", runtime)
  assert.equal(spawned.cmd, runtime.cmd)
  assert.ok(spawned.args.some((arg) => arg.endsWith("daemon.ts")))
})

test("daemon stops voice after OpenCode remains disconnected", async () => {
  const id = `${process.pid}-${Date.now()}-exit`
  const sockPath = join(tmpdir(), `vox-voice-${id}.sock`)
  const pidPath = join(tmpdir(), `vox-voice-${id}.pid`)
  const daemon = await listenVoiceDaemon({
    sockPath,
    pidPath,
    idleExitMs: 25,
    createSupervisor: () => fakeSupervisor(),
  })
  try {
    const bridge = await attachVoiceDaemon({ sockPath, pidPath, options: { autoStopOnOpenCodeExit: true } })
    await bridge.start()
    await bridge.dispose()
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(existsSync(sockPath), false)
  } finally {
    await daemon.close()
  }
})

test("daemon can keep voice alive after OpenCode exits when configured", async () => {
  const id = `${process.pid}-${Date.now()}-keep`
  const sockPath = join(tmpdir(), `vox-voice-${id}.sock`)
  const pidPath = join(tmpdir(), `vox-voice-${id}.pid`)
  const daemon = await listenVoiceDaemon({
    sockPath,
    pidPath,
    idleExitMs: 25,
    createSupervisor: () => fakeSupervisor(),
  })
  try {
    const bridge = await attachVoiceDaemon({ sockPath, pidPath, options: { autoStopOnOpenCodeExit: false } })
    await bridge.start()
    await bridge.dispose()
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(existsSync(sockPath), true)
  } finally {
    await daemon.close()
  }
})

test("daemon session tools RPC through the TUI OpenCode client", async () => {
  const id = `${process.pid}-${Date.now()}-rpc`
  const sockPath = join(tmpdir(), `vox-voice-${id}.sock`)
  const pidPath = join(tmpdir(), `vox-voice-${id}.pid`)
  const created: Array<Record<string, unknown>> = []
  const sessionClient: SessionClient = {
    session: {
      list: async () => ({ data: [] }),
      create: async (parameters) => {
        created.push({ ...parameters })
        return { data: { id: "ses_pong", title: parameters?.title ?? "Pong", directory: parameters?.directory } }
      },
      get: async () => ({ data: { id: "ses_pong", title: "Pong" } }),
      status: async () => ({ data: {} }),
      abort: async () => ({ data: true }),
      promptAsync: async () => ({}),
      diff: async () => ({ data: [] }),
    },
    permission: { respond: async () => ({ data: true }) },
  }
  let daemonClient: { session: { create: SessionClient["session"]["create"] } } | undefined

  const daemon = await listenVoiceDaemon({
    sockPath,
    pidPath,
    idleExitMs: 60_000,
    createSupervisor: (input) => {
      daemonClient = input.client
      return fakeSupervisor()
    },
  })

  try {
    const bridge = await attachVoiceDaemon({
      sockPath,
      pidPath,
      sessionClient,
      directory: "/Users/joshuaattridge/vox-code",
    })
    const result = await daemonClient?.session.create({ title: "Pong game", directory: "/Users/joshuaattridge/pong" })
    assert.equal(result?.data?.id, "ses_pong")
    assert.deepEqual(created, [{ title: "Pong game", directory: "/Users/joshuaattridge/pong" }])
    await bridge.dispose()
  } finally {
    await daemon.close()
    try {
      unlinkSync(sockPath)
    } catch {
      // already removed
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // already removed
    }
  }
})

test("RPC replies bypass a command waiting for TUI context", { timeout: 5000 }, async () => {
  const id = `${process.pid}-${Date.now()}-queue`
  const sockPath = join(tmpdir(), `vox-${id}.sock`)
  const pidPath = join(tmpdir(), `vox-${id}.pid`)
  let context: unknown
  const daemon = await listenVoiceDaemon({ sockPath, pidPath, createSupervisor: (input) => {
    const inner = fakeSupervisor()
    return { ...inner, start: async () => {
      context = await input.currentContext()
      await inner.start()
    } }
  } })
  try {
    const bridge = await attachVoiceDaemon({ sockPath, pidPath, hooks: { currentContext: () => ({ route: "home" }) } })
    await bridge.start()
    assert.deepEqual(context, { route: "home" })
    assert.equal(bridge.state().phase, "connected")
    await bridge.dispose()
  } finally { await daemon.close() }
})

test("switching between TUI clients restores each client's session and directory", async () => {
  const id = `${process.pid}-${Date.now()}-contexts`
  const sockPath = join(tmpdir(), `vox-${id}.sock`)
  const pidPath = join(tmpdir(), `vox-${id}.pid`)
  let readDirectory!: () => string | undefined
  let readSession!: () => string | undefined
  const daemon = await listenVoiceDaemon({ sockPath, pidPath, createSupervisor: (input) => {
    readDirectory = input.directory
    readSession = input.currentSessionId
    return fakeSupervisor()
  } })
  try {
    const a = await attachVoiceDaemon({ sockPath, pidPath, directory: "/project/a", sessionId: "ses_a" })
    const b = await attachVoiceDaemon({ sockPath, pidPath, directory: "/project/b" })
    assert.equal(readDirectory(), "/project/b")
    assert.equal(readSession(), undefined)
    a.setCurrentSession("ses_a")
    await until(() => readSession() === "ses_a")
    assert.equal(readDirectory(), "/project/a")
    await a.dispose()
    await until(() => readDirectory() === "/project/b")
    assert.equal(readSession(), undefined)
    await b.dispose()
  } finally { await daemon.close() }
})
