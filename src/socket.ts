import { Buffer } from "node:buffer"
import WebSocket from "ws"
type SocketEvent = "open" | "message" | "close" | "error"

export type SocketLike = {
  readyState: number
  send: (data: string) => void
  close: () => void
  on?: (event: string, listener: (...args: any[]) => void) => void
  off?: (event: string, listener: (...args: any[]) => void) => void
  addEventListener?: (event: SocketEvent, listener: (event: any) => void) => void
  removeEventListener?: (event: SocketEvent, listener: (event: any) => void) => void
}

export function listenSocket(socket: SocketLike, event: SocketEvent, listener: (...args: any[]) => void) {
  // ws supports both APIs. Register exactly once, and remove handshake listeners.
  if (socket.on) {
    socket.on(event, listener)
    return () => socket.off?.(event, listener)
  }
  const wrapped = (value: any) => listener(event === "message" ? value.data : value)
  socket.addEventListener?.(event, wrapped)
  return () => socket.removeEventListener?.(event, wrapped)
}

export function socketText(raw: unknown) {
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)
}

export function attachSocket(socket: SocketLike, handlers: {
  message: (raw: string) => void
  close: () => void
  error: (message: string) => void
}) {
  listenSocket(socket, "message", (raw) => handlers.message(socketText(raw)))
  listenSocket(socket, "close", handlers.close)
  listenSocket(socket, "error", (error) => handlers.error(error?.message ?? String(error)))
}

export function openSocket(url: string, headers: Record<string, string>): SocketLike {
  // Return while connecting so callers install listeners before the first event.
  return new WebSocket(url, { headers, handshakeTimeout: 8000 })
}

export function handshake(socket: SocketLike, payload: unknown, readyEvent: string, label: string, timeoutMs = 8000) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let sent = false
    const cleanup: Array<() => void> = []
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const remove of cleanup) remove()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error(`${label} connection timed out`)), timeoutMs)
    const start = () => {
      if (sent || settled || socket.readyState !== 1) return
      sent = true
      try { socket.send(JSON.stringify(payload)) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    }
    cleanup.push(listenSocket(socket, "message", (raw) => {
      let event
      try { event = JSON.parse(socketText(raw)) } catch { return }
      if (event?.type === readyEvent) finish()
      if (event?.type === "error") finish(new Error(event.error?.message ?? `${label} error`))
    }))
    cleanup.push(listenSocket(socket, "close", () => finish(new Error(`${label} closed during startup`))))
    cleanup.push(listenSocket(socket, "error", (error) => finish(new Error(error?.message ?? `${label} socket error`))))
    cleanup.push(listenSocket(socket, "open", start))
    if (socket.readyState > 1) finish(new Error(`${label} socket is closed`))
    else start()
  })
}
