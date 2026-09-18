import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import WebSocket, { WebSocketServer } from "ws"
import { attachVoiceDaemon } from "../../src/bridge.ts"
import { listenVoiceDaemon } from "../../src/daemon.ts"
import { createVoiceSupervisor, type VoiceSupervisor } from "../../src/supervisor.ts"
import { MemoryAudio, PcmWritePump, FRAME_BYTES, makeSinePcm, PREROLL_MS } from "../../src/audio.ts"
import { openRealtime } from "../../src/realtime.ts"
import { openLive } from "../../src/live.ts"
import { createHttpSessionClient } from "../../src/http-client.ts"
import { until } from "../helpers.ts"

class MonitoringAudio extends MemoryAudio {
  #pump = new PcmWritePump()
  #queue: Buffer[] = []
  #speaker: Buffer[] = []
  #timer?: ReturnType<typeof setInterval>
  #preroll?: ReturnType<typeof setTimeout>
  #lastTick = 0
  #expectedBytes = 0
  underrunBytes = 0

  expectOutput(pcm: Buffer) {
    this.#expectedBytes = pcm.length
  }

  get speakerOutput() {
    return Buffer.concat(this.#speaker)
  }

  override async startPlayback() {}

  override async play(pcm: Buffer) {
    this.played.push(pcm)
    const flushed = this.#pump.push(pcm)
    if (flushed) {
      this.#clearPreroll()
      this.#write(flushed)
      return
    }
    this.#clearPreroll()
    this.#preroll = setTimeout(() => {
      this.#preroll = undefined
      const held = this.#pump.flushIfWaited(PREROLL_MS)
      if (held) this.#write(held)
    }, PREROLL_MS)
  }

  override async drainPlayback() {
    const held = this.#pump.flushHeld()
    if (held) this.#write(held)
    await until(() => this.speakerOutput.length >= this.#expectedBytes, 5_000)
  }

  override async stopPlayback() {
    this.#clearPreroll()
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#queue = []
    this.#pump.reset()
  }

  #write(pcm: Buffer) {
    this.#queue.push(pcm)
    if (this.#timer) return
    this.#lastTick = Date.now()
    this.#timer = setInterval(() => this.#consume(), 5)
  }

  #consume() {
    const now = Date.now()
    const bytes = Math.floor(((now - this.#lastTick) * 48) / 2) * 2
    this.#lastTick = now
    let remaining = bytes
    while (remaining && this.#queue.length) {
      const chunk = this.#queue[0]
      const take = Math.min(remaining, chunk.length)
      this.#speaker.push(chunk.subarray(0, take))
      remaining -= take
      if (take === chunk.length) this.#queue.shift()
      else this.#queue[0] = chunk.subarray(take)
    }
    if (remaining && this.speakerOutput.length < this.#expectedBytes) this.underrunBytes += remaining
    if (this.speakerOutput.length >= this.#expectedBytes && this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  #clearPreroll() {
    if (!this.#preroll) return
    clearTimeout(this.#preroll)
    this.#preroll = undefined
  }
}

async function harness(t: TestContext, live = false, audio: MemoryAudio = new MemoryAudio()) {
  const root = mkdtempSync(join(tmpdir(), "vox-e2e-"))
  const requests: Array<{ path: string; method: string; directory: string | null; body: any }> = []
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const url = new URL(req.url!, "http://localhost")
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    requests.push({ path: url.pathname, method: req.method!, directory: url.searchParams.get("directory"), body })
    res.setHeader("content-type", "application/json")
    const session = { id: "ses_worker", title: "Voice worker", directory: root }
    let result: unknown = true
    if (url.pathname === "/session/status") result = {}
    else if (url.pathname.endsWith("/prompt_async")) { res.writeHead(204).end(); return }
    else if (url.pathname.endsWith("/message")) result = [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Worker completed successfully." }] }]
    else if (url.pathname.endsWith("/diff")) result = [{ file: "index.ts", additions: 2, deletions: 1 }]
    else if (url.pathname === "/session" && req.method === "GET") result = [session]
    else if (url.pathname === "/session" || url.pathname === "/session/ses_worker") result = session
    res.end(JSON.stringify(result))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const httpAddress = http.address() as { port: number }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const connections: Array<{ socket: WebSocket; received: any[] }> = []
  server.on("connection", (socket) => {
    const peer = { socket, received: [] as any[] }
    connections.push(peer)
    socket.on("message", (raw) => {
      const event = JSON.parse(String(raw))
      peer.received.push(event)
      if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }))
      if (event.type === "session.start") socket.send(JSON.stringify({ type: "session.started" }))
      if (event.type === "session.close") socket.send(JSON.stringify({ type: "session.closed" }))
    })
  })
  const focused: string[] = []
  let inner!: VoiceSupervisor
  const sockPath = join(root, "voice.sock")
  const pidPath = join(root, "voice.pid")
  const daemon = await listenVoiceDaemon({ sockPath, pidPath, idleExitMs: 60_000, createSupervisor: (input) => {
    inner = createVoiceSupervisor({
      client: input.client, directory: input.directory, options: input.options, audio,
      resolveKey: () => ({ key: "test-only", source: "plugin", hint: "test" }),
      hooks: { currentSessionId: input.currentSessionId, focusSession: input.focusSession, toast: input.toast, currentContext: input.currentContext },
      connect: (options) => {
        const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
        return live ? openLive({ ...options, socket }) : openRealtime({ ...options, socket })
      },
    })
    return inner
  } })
  const bridges: VoiceSupervisor[] = []
  t.after(async () => {
    await daemon.close()
    for (const bridge of bridges) await bridge.dispose()
    for (const peer of connections) peer.socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  const attach = async (sessionId?: string) => {
    const bridge = await attachVoiceDaemon({
      sockPath, pidPath, directory: root, sessionId,
      options: { model: live ? "gpt-live-1" : "gpt-realtime", inactivityTimeoutMinutes: 0 },
      sessionClient: createHttpSessionClient({ baseUrl: `http://127.0.0.1:${httpAddress.port}` }),
      hooks: {
        focusSession: (id) => { focused.push(id); return true },
        currentContext: () => ({ route: { name: sessionId ? "session" : "home" }, sessionId }),
      },
    })
    bridges.push(bridge)
    return bridge
  }
  const bridge = await attach("ses_current")
  await bridge.start()
  assert.equal(bridge.state().phase, "connected")
  const peer = () => connections.at(-1)!
  const emit = (event: unknown) => peer().socket.send(JSON.stringify(event))
  let sequence = 0
  const tool = async (name: string, args: Record<string, unknown>) => {
    const id = `call_${++sequence}`
    const item = { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }
    if (live) {
      emit({ type: "response.event", delegation_id: id, event: { type: "response.created", response: { id } } })
      emit({ type: "response.event", delegation_id: id, event: { type: "response.output_item.done", item } })
      emit({ type: "response.event", delegation_id: id, event: { type: "response.completed", response: { output: [] } } })
    } else {
      emit({ type: "response.created", response: { id } })
      emit({ type: "response.output_item.done", item })
      emit({ type: "response.done", response: { status: "completed", output: [item] } })
    }
    await until(() => peer().received.some((e) => e.item?.call_id === id))
    return JSON.parse(peer().received.find((e) => e.item?.call_id === id).item.output)
  }
  return { root, requests, audio, focused, inner, bridge, attach, peer, emit, tool, connections }
}

test("Realtime: jittered response reaches the simulated speaker without an underrun", { timeout: 15_000 }, async (t) => {
  const audio = new MonitoringAudio()
  const h = await harness(t, false, audio)
  const output = makeSinePcm(440, 2)
  audio.expectOutput(output)

  for (let offset = 0, packet = 0; offset < output.length; offset += FRAME_BYTES, packet += 1) {
    h.emit({
      type: "response.output_audio.delta",
      item_id: "jittered_speech",
      delta: output.subarray(offset, offset + FRAME_BYTES).toString("base64"),
    })
    // Ordinary WebSocket jitter must not empty the small low-latency preroll.
    await new Promise((resolve) => setTimeout(resolve, packet === 19 ? 80 : 20))
  }
  h.emit({ type: "response.output_audio.done" })
  await until(() => h.inner.state().phase === "connected", 6_000)

  assert.equal(audio.underrunBytes, 0)
  assert.deepEqual(audio.speakerOutput, output)
})

for (const live of [false, true]) {
  const label = live ? "Live" : "Realtime"
  test(`${label}: bridge → daemon → WebSocket → tool RPC → HTTP worker and audio round trip`, { timeout: 15_000 }, async (t) => {
    const h = await harness(t, live)
    const input = makeSinePcm(330, 0.02)
    h.audio.push(input.subarray(0, 7))
    h.audio.push(input.subarray(7))
    const inputEvent = live ? "session.input_audio.append" : "input_audio_buffer.append"
    await until(() => h.peer().received.filter((e) => e.type === inputEvent).length === 2)
    const receivedAudio = Buffer.concat(h.peer().received.filter((e) => e.type === inputEvent).map((e) => Buffer.from(e.audio, "base64")))
    assert.deepEqual(receivedAudio, input)

    const created = await h.tool("create_session", { title: "Voice worker", prompt: "Write the tests" })
    assert.equal(created.id, "ses_worker")
    assert.deepEqual(h.focused, ["ses_worker"])
    await until(() => h.bridge.state().ownedSessionIds.includes("ses_worker"))
    assert.ok(h.requests.some((r) => r.path.endsWith("/prompt_async") && r.body.parts[0].text === "Write the tests"))
    const status = await h.tool("session_status", { session_id: "ses_worker" })
    assert.equal(status.complete, true)
    assert.match(status.lastMessage, /completed successfully/)
    const context = await h.tool("current_context", {})
    assert.equal(context.sessionId, "ses_current")
    const listed = await h.tool("list_sessions", {})
    assert.ok(JSON.stringify(listed).includes("ses_worker"))
    await h.tool("reply_permission", { session_id: "ses_worker", permission_id: "perm_1", reply: "once" })
    assert.ok(h.requests.some((r) => r.path.endsWith("/permissions/perm_1") && r.body.response === "once"))
    await h.tool("abort_session", { session_id: "ses_worker" })
    assert.ok(h.requests.some((r) => r.path.endsWith("/abort")))

    const output = makeSinePcm(440, 0.04)
    const audioEvent = live ? "session.output_audio.delta" : "response.output_audio.delta"
    h.emit({ type: audioEvent, item_id: "speech_1", delta: output.subarray(0, 960).toString("base64") })
    h.emit({ type: audioEvent, item_id: "speech_1", delta: output.subarray(960).toString("base64") })
    if (!live) h.emit({ type: "response.output_audio.done" })
    await until(() => h.audio.played.length === 2)
    assert.deepEqual(Buffer.concat(h.audio.played), output)
    await until(() => h.inner.state().phase === "connected")
    await h.bridge.stop()
    assert.equal(h.audio.capturing, false)
    assert.equal(h.bridge.state().desiredOn, false)
  })

  test(`${label}: TUI reattach, home context, provider disconnect, recovery and explicit stop`, { timeout: 15_000 }, async (t) => {
    const h = await harness(t, live)
    await h.bridge.dispose()
    const again = await h.attach()
    assert.equal(again.state().realtimeConnected, true)
    assert.equal(h.connections.length, 1)
    assert.equal((await h.tool("current_context", {})).route.name, "home")
    const current = await h.tool("prompt_session", { session_id: "current", prompt: "should not run" })
    assert.match(current.error, /No current session/)
    h.peer().socket.terminate()
    await until(() => h.inner.state().phase === "reconnecting")
    await until(() => h.connections.length === 2 && h.inner.state().phase === "connected", 4000)
    await until(() => again.state().phase === "connected")
    await again.stop()
    assert.equal(again.state().phase, "off")
    assert.equal(h.audio.capturing, false)
  })
}
