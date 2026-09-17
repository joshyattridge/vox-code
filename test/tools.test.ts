import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createSessionController, lastAssistantText } from "../src/sessions.ts"
import { executeTool, parseToolArgs } from "../src/tools.ts"
import type { SessionClient, SessionInfo } from "../src/client.ts"

function mockClient(seed: SessionInfo[] = []): SessionClient & { prompts: Array<{ id: string; text: string }> } {
  const sessions = [...seed]
  const statuses: Record<string, { type: string }> = {}
  const prompts: Array<{ id: string; text: string }> = []
  let n = 0
  return {
    prompts,
    session: {
      async list() {
        return { data: sessions }
      },
      async create(options) {
        n += 1
        const created: SessionInfo = {
          id: `ses_${n}`,
          title: options?.title ?? `Session ${n}`,
          directory: options?.directory,
        }
        sessions.push(created)
        statuses[created.id] = { type: "idle" }
        return { data: created }
      },
      async get(options) {
        const found = sessions.find((row) => row.id === options.sessionID)
        return found ? { data: found } : { error: { message: "not found" } }
      },
      async status() {
        return { data: statuses }
      },
      async abort(options) {
        statuses[options.sessionID] = { type: "idle" }
        return { data: true }
      },
      async promptAsync(options) {
        const text = (options.parts ?? []).map((part) => part.text).join("")
        prompts.push({ id: options.sessionID, text })
        statuses[options.sessionID] = { type: "busy" }
        return {}
      },
      async diff() {
        return { data: [{ file: "src/app.ts", additions: 3, deletions: 1 }] }
      },
      async messages() {
        return {
          data: {
            data: [
              { type: "user", text: "clean up game folders" },
              {
                type: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Removed /Users/joshuaattridge/tetris-game. Cleanup completed successfully.",
                  },
                ],
              },
            ],
          },
        }
      },
    },
    permission: {
      async respond() {
        return { data: true }
      },
    },
  }
}

test("create_session marks the worker as owned", async () => {
  const client = mockClient()
  const sessions = createSessionController(client)
  const created = await executeTool("create_session", { title: "tests" }, sessions, {})
  const output = created.output as { id: string; owned: boolean; title: string }
  assert.equal(output.title, "tests")
  assert.equal(output.owned, true)
  const list = await executeTool("list_sessions", {}, sessions, {})
  const rows = (list.output as { sessions: Array<{ owned: boolean }> }).sessions
  assert.equal(rows.filter((row) => row.owned).length, 1)
})

test("prompt_session is non-blocking and records the prompt", async () => {
  const client = mockClient([{ id: "ses_a", title: "auth" }])
  const sessions = createSessionController(client)
  const result = await executeTool(
    "prompt_session",
    { session_id: "ses_a", prompt: "write tests" },
    sessions,
    {},
  )
  assert.deepEqual(result.output, { accepted: true, sessionId: "ses_a" })
  assert.equal(client.prompts[0]?.id, "ses_a")
  assert.equal(client.prompts[0]?.text, "write tests")
})

test("prompt_session accepts a 204 empty promptAsync response", async () => {
  const client = mockClient([{ id: "ses_f5469aa2cffen2cGa0WOnbm9AD", title: "snake" }])
  const sessions = createSessionController(client)
  const result = await executeTool(
    "prompt_session",
    { session_id: "ses_f5469aa2cffen2cGa0WOnbm9AD", prompt: "build a snake game" },
    sessions,
    {},
  )
  assert.deepEqual(result.output, {
    accepted: true,
    sessionId: "ses_f5469aa2cffen2cGa0WOnbm9AD",
  })
  assert.match(client.prompts[0]?.id ?? "", /^ses_/)
})

test("prompt_session current resolves the focused session", async () => {
  const client = mockClient([{ id: "focused", title: "here" }])
  const sessions = createSessionController(client)
  const result = await executeTool(
    "prompt_session",
    { session_id: "current", prompt: "continue" },
    sessions,
    { currentSessionId: "focused" },
  )
  assert.deepEqual(result.output, { accepted: true, sessionId: "focused" })
})

test("create_session creates a missing folder and focuses it", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice-ses-"))
  const dir = join(root, "Snake")
  try {
    const client = mockClient()
    const focused: string[] = []
    const sessions = createSessionController(client)
    const result = await executeTool(
      "create_session",
      { title: "Snake game", directory: dir },
      sessions,
      { directory: join(root, "other") },
      async (id) => {
        focused.push(id)
        return true
      },
    )
    assert.equal(existsSync(dir), true)
    const output = result.output as { title: string; directory?: string; focused?: boolean }
    assert.equal(output.title, "Snake game")
    assert.equal(output.directory, dir)
    assert.equal(output.focused, true)
    assert.deepEqual(focused, ["ses_1"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("create_session focuses the TUI for the current project", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice-ses-"))
  try {
    const client = mockClient()
    const focused: string[] = []
    const sessions = createSessionController(client, root)
    const result = await executeTool(
      "create_session",
      { title: "here" },
      sessions,
      { directory: root },
      async (id) => {
        focused.push(id)
        return true
      },
    )
    const output = result.output as { focused?: boolean; directory?: string }
    assert.equal(output.directory, root)
    assert.equal(output.focused, true)
    assert.deepEqual(focused, ["ses_1"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("create_session warns when sharing a checkout", async () => {
  const client = mockClient()
  const sessions = createSessionController(client)
  const result = await executeTool("create_session", { title: "two" }, sessions, { warnSharedCheckout: true })
  const output = result.output as { warning?: string }
  assert.match(String(output.warning), /same checkout/)
})

test("create_session with prompt starts work and focuses in one call", async () => {
  const client = mockClient()
  const focused: string[] = []
  const sessions = createSessionController(client, "/tmp/here")
  const result = await executeTool(
    "create_session",
    { title: "tetris", prompt: "build tetris" },
    sessions,
    { directory: "/tmp/here" },
    async (id) => {
      focused.push(id)
      return true
    },
  )
  const output = result.output as { focused?: boolean; prompted?: boolean; id: string }
  assert.equal(output.focused, true)
  assert.equal(output.prompted, true)
  assert.deepEqual(focused, [output.id])
  assert.equal(client.prompts[0]?.text, "build tetris")
})

test("focus_session opens a worker in another project", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice-ses-"))
  const other = join(root, "pong")
  try {
    const client = mockClient()
    const focused: string[] = []
    const sessions = createSessionController(client)
    const created = await sessions.create({ title: "pong", directory: other })
    const result = await executeTool(
      "focus_session",
      { session_id: created.id },
      sessions,
      { directory: join(root, "vox-code") },
      async (id) => {
        focused.push(id)
        return true
      },
    )
    const output = result.output as { focused?: boolean; sessionId?: string }
    assert.equal(output.focused, true)
    assert.equal(output.sessionId, created.id)
    assert.deepEqual(focused, [created.id])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reply_permission validates the reply enum", async () => {
  const client = mockClient()
  const sessions = createSessionController(client)
  await assert.rejects(
    executeTool("reply_permission", { session_id: "x", permission_id: "p", reply: "maybe" }, sessions, {}),
  )
})

test("session_status treats a finished worker as complete and returns lastMessage", async () => {
  const client = mockClient([{ id: "ses_done", title: "Cleanup" }])
  const sessions = createSessionController(client)
  sessions.markOwned("ses_done")
  const result = await executeTool("session_status", { session_id: "ses_done" }, sessions, {})
  const output = result.output as { status: string; complete?: boolean; lastMessage?: string }
  assert.equal(output.status, "idle")
  assert.equal(output.complete, true)
  assert.match(String(output.lastMessage), /tetris-game/)
})

test("lastAssistantText reads GPT-Live and OpenCode message shapes", () => {
  assert.match(
    lastAssistantText({
      data: [{ type: "assistant", content: [{ type: "text", text: "Removed pong." }] }],
    }) ?? "",
    /Removed pong/,
  )
  assert.match(
    lastAssistantText([{ info: { role: "assistant" }, parts: [{ type: "text", text: "Done." }] }]) ?? "",
    /Done/,
  )
})

test("parseToolArgs reads JSON objects", () => {
  assert.deepEqual(parseToolArgs(`{"title":"auth"}`), { title: "auth" })
  assert.deepEqual(parseToolArgs(""), {})
  assert.deepEqual(parseToolArgs("[]"), {})
})

test("parseToolArgs repairs truncated realtime tool JSON instead of throwing", () => {
  const parsed = parseToolArgs(
    `{"title":"New Project Setup","prompt":"Create a fresh project environment for the user to start coding. Ask minimal clarifying questions only if needed, otherwise set up a basic`,
  )
  assert.equal(parsed.title, "New Project Setup")
  assert.match(String(parsed.prompt), /fresh project environment/)
})

test("parseToolArgs returns empty object for junk JSON", () => {
  assert.deepEqual(parseToolArgs("{not json"), {})
})
