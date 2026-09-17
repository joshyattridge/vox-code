import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { resolveWorkerDirectory, sameDirectory } from "../src/paths.ts"

test("maps Linux home paths onto this machine's home", () => {
  assert.equal(resolveWorkerDirectory("/home/pong"), join(homedir(), "pong"))
  assert.equal(resolveWorkerDirectory("/root/pong"), join(homedir(), "pong"))
  assert.equal(resolveWorkerDirectory("/workspace/tetris"), join(homedir(), "tetris"))
  assert.equal(resolveWorkerDirectory("~/pong"), join(homedir(), "pong"))
})

test("maps /tmp project paths off macOS tmp", () => {
  if (process.platform === "linux") return
  assert.equal(resolveWorkerDirectory("/tmp/pong"), join(homedir(), "pong"))
  assert.equal(resolveWorkerDirectory("/private/tmp/tetris"), join(homedir(), "tetris"))
})

test("keeps an omitted directory on the current project", () => {
  assert.equal(resolveWorkerDirectory(undefined, "/Users/me/project"), "/Users/me/project")
})

test("sameDirectory compares resolved paths", () => {
  assert.equal(sameDirectory("/tmp/a", "/tmp/a/../a"), true)
  assert.equal(sameDirectory("/tmp/a", "/tmp/b"), false)
  assert.equal(sameDirectory(undefined, "/tmp/a"), false)
})
