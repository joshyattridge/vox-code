import assert from "node:assert/strict"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { test } from "node:test"
import { attachVoiceDaemon, daemonSpawnArgs, isJsRuntime, resolveDaemonRuntime } from "../src/bridge.ts"
import type { SessionClient } from "../src/client.ts"
import { listenVoiceDaemon } from "../src/daemon.ts"
import type { VoiceSupervisor } from "../src/supervisor.ts"
import { chipLabel, initialVoiceState, type VoiceUiState } from "../src/types.ts"

function fakeSupervisor(): VoiceSupervisor {
  let state: VoiceUiState = initialVoiceState()
  let model = "gpt-realtime"
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const start = async () => {
    state = { ...state, phase: "connected", realtimeConnected: true }
    notify()
  }
  const stop = async () => {
    state = initialVoiceState()
    notify()
  }
  return {
    state: () => state,
    model: () => model,
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
    async mute() {
      state = { ...state, muted: true, phase: state.realtimeConnected ? "muted" : state.phase }
      notify()
    },
    async unmute() {
      state = { ...state, muted: false, phase: state.realtimeConnected ? "connected" : state.phase }
      notify()
    },
    async setModel(next) {
      model = next.trim()
      notify()
    },
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
  const focused: Array<{ sessionId: string; directory?: string }> = []
  let focusFromDaemon: ((sessionId: string, directory?: string) => boolean | Promise<boolean>) | undefined

  const daemon = await listenVoiceDaemon({
    sockPath,
    pidPath,
    idleExitMs: 60_000,
    createSupervisor: (input) => {
      focusFromDaemon = input.focusSession
      return inner
    },
  })

  try {
    const bridge = await attachVoiceDaemon({
      sockPath,
      pidPath,
      options: { model: "gpt-live-1" },
      hooks: {
        focusSession: async (sessionId, directory) => {
          focused.push({ sessionId, directory })
          return true
        },
      },
    })
    await bridge.start()
    assert.equal(bridge.state().phase, "connected")
    assert.equal(inner.state().phase, "connected")

    await focusFromDaemon?.("ses_worker", "/tmp/mario-game")
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(focused, [{ sessionId: "ses_worker", directory: "/tmp/mario-game" }])

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
