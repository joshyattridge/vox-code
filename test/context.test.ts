import assert from "node:assert/strict"
import { test } from "node:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { collectCurrentContext } from "../src/context.ts"

test("current context is bounded to recent text and changed-file summaries", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    id: `msg_${index}`,
    sessionID: "ses_1",
    role: index % 2 ? "assistant" : "user",
    time: { created: index },
    ...(index % 2
      ? { providerID: "openai", modelID: "gpt-5", mode: "chat", agent: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_0" }
      : { agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }),
  }))
  const api = {
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    state: {
      path: { directory: "/repo", worktree: "/repo" },
      config: {},
      session: {
        get: () => ({
          id: "ses_1",
          title: "Current work",
          directory: "/repo",
          model: { providerID: "openai", id: "gpt-5", variant: "high" },
        }),
        status: () => ({ type: "busy" }),
        messages: () => messages,
        diff: () => Array.from({ length: 25 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: index, deletions: 0 })),
      },
      part: (messageID: string) => [
        { type: "text", text: `${messageID} ${"x".repeat(1200)}` },
        { type: "tool", input: "secret tool input" },
      ],
    },
  } as unknown as TuiPluginApi

  const context = collectCurrentContext(api) as {
    route: { sessionID: string }
    model: { modelID: string }
    messages: { totalCached: number; returned: number; items: Array<{ text: string }> }
    sessionChanges: { total: number; returned: number; truncated: boolean; files: unknown[] }
    visible: { available: boolean }
  }
  assert.equal(context.route.sessionID, "ses_1")
  assert.equal(context.model.modelID, "gpt-5")
  assert.equal(context.messages.totalCached, 8)
  assert.ok(context.messages.returned <= 6)
  assert.ok(context.messages.items.every((item) => item.text.length <= 1000))
  assert.ok(context.messages.items.reduce((sum, item) => sum + item.text.length, 0) <= 4000)
  assert.doesNotMatch(JSON.stringify(context), /secret tool input/)
  assert.equal(context.sessionChanges.total, 25)
  assert.equal(context.sessionChanges.returned, 20)
  assert.equal(context.sessionChanges.truncated, true)
  assert.equal(context.sessionChanges.files.length, 20)
  assert.equal(context.visible.available, false)
})

test("home context does not leak a stale session", () => {
  const api = {
    route: { current: { name: "home" } },
    state: { path: { directory: "/repo", worktree: "/repo" } },
  } as unknown as TuiPluginApi
  const context = collectCurrentContext(api)
  assert.equal("session" in context, false)
  assert.equal("messages" in context, false)
})
