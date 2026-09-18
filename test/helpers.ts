import { EventEmitter } from "node:events"

export class FakeSocket {
  readyState = 1
  sent: any[] = []
  closed = false
  events = new EventEmitter()
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.events.emit("close")
  }
  on(event: string, listener: (...args: any[]) => void) { this.events.on(event, listener) }
  off(event: string, listener: (...args: any[]) => void) { this.events.off(event, listener) }
  emit(payload: unknown) { this.events.emit("message", JSON.stringify(payload)) }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
