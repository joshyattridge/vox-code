import assert from "node:assert/strict"
import { test } from "node:test"
import { createSessionController } from "../src/sessions.ts"
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
          title: options?.body?.title ?? `Session ${n}`,
          directory: options?.query?.directory,
        }
        sessions.push(created)
        statuses[created.id] = { type: "idle" }
        return { data: created }
      },
      async get(options) {
        const found = sessions.find((row) => row.id === options.path.id)
        return found ? { data: found } : { error: { message: "not found" } }
      },
      async status() {
        return { data: statuses }
      },
      async abort(options) {
        statuses[options.path.id] = { type: "idle" }
        return { data: true }
      },
      async promptAsync(options) {
        const text = options.body.parts.map((part) => part.text).join("")
        prompts.push({ id: options.path.id, text })
        statuses[options.path.id] = { type: "busy" }
        return { data: { ok: true } }
      },
      async diff() {
        return { data: [{ file: "src/app.ts", additions: 3, deletions: 1 }] }
      },
    },
    async postSessionIdPermissionsPermissionId() {
      return { data: true }
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
  assert.equal(client.prompts[0]?.text, "write tests")
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

test("create_session warns when sharing a checkout", async () => {
  const client = mockClient()
  const sessions = createSessionController(client)
  const result = await executeTool("create_session", { title: "two" }, sessions, { warnSharedCheckout: true })
  const output = result.output as { warning?: string }
  assert.match(String(output.warning), /same checkout/)
})

test("reply_permission validates the reply enum", async () => {
  const client = mockClient()
  const sessions = createSessionController(client)
  await assert.rejects(
    executeTool("reply_permission", { session_id: "x", permission_id: "p", reply: "maybe" }, sessions, {}),
  )
})

test("parseToolArgs reads JSON objects", () => {
  assert.deepEqual(parseToolArgs(`{"title":"auth"}`), { title: "auth" })
  assert.deepEqual(parseToolArgs(""), {})
})
