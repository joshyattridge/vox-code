import assert from "node:assert/strict"
import { test } from "node:test"
import { handshake } from "../src/socket.ts"
import { FakeSocket } from "./helpers.ts"

test("handshake timeout releases temporary listeners", async () => {
  const socket = new FakeSocket()
  await assert.rejects(handshake(socket, { type: "start" }, "ready", "Test", 10), /timed out/)
  for (const event of ["open", "message", "error", "close"]) {
    assert.equal(socket.events.listenerCount(event), 0)
  }
})

test("handshake sends once even if open is reported twice", async () => {
  const socket = new FakeSocket()
  socket.readyState = 0
  const pending = handshake(socket, { type: "start" }, "ready", "Test")
  assert.equal(socket.sent.length, 0)
  socket.readyState = 1
  socket.events.emit("open")
  socket.events.emit("open")
  socket.emit({ type: "ready" })
  await pending
  assert.deepEqual(socket.sent, [{ type: "start" }])
})

test("handshake supports EventTarget sockets and removes listeners", async () => {
  const events = new EventTarget()
  const socket = {
    readyState: 1,
    send() { queueMicrotask(() => events.dispatchEvent(new MessageEvent("message", { data: '{"type":"ready"}' }))) },
    close() {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  }
  await handshake(socket, {}, "ready", "Test")
})
