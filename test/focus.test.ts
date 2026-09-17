import assert from "node:assert/strict"
import { test } from "node:test"
import { focusTuiSession, sessionRouteFocused, type TuiFocusApi } from "../src/focus.ts"

function mockApi(input?: { current?: TuiFocusApi["route"]["current"]; selectError?: unknown }): TuiFocusApi & {
  selected: Array<{ sessionID: string; directory?: string }>
  published: unknown[]
  toasts: Array<{ message: string; variant?: string }>
} {
  const selected: Array<{ sessionID: string; directory?: string }> = []
  const published: unknown[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  let current = input?.current ?? { name: "home" }
  return {
    selected,
    published,
    toasts,
    route: {
      get current() {
        return current
      },
      navigate(name, params) {
        current = { name, params }
      },
    },
    client: {
      tui: {
        async selectSession(params) {
          selected.push(params)
          if (input?.selectError) return { error: input.selectError }
          return {}
        },
        async publish(params) {
          published.push(params.body)
          return {}
        },
      },
    },
    ui: {
      toast(toast) {
        toasts.push(toast)
      },
    },
  }
}

test("sessionRouteFocused only matches the session view", () => {
  assert.equal(sessionRouteFocused({ name: "home" }, "ses_1"), false)
  assert.equal(sessionRouteFocused({ name: "session", params: { sessionID: "ses_1" } }, "ses_1"), true)
  assert.equal(sessionRouteFocused({ name: "session", params: { sessionID: "ses_2" } }, "ses_1"), false)
})

test("focusTuiSession navigates the visible TUI before selectSession", async () => {
  const api = mockApi()
  const focused = await focusTuiSession(api, "ses_tetris", "/Users/me/tetris", "/Users/me")
  assert.equal(focused, true)
  assert.deepEqual(api.route.current, { name: "session", params: { sessionID: "ses_tetris" } })
  assert.deepEqual(api.selected, [{ sessionID: "ses_tetris", directory: "/Users/me" }])
  assert.deepEqual(api.published, [{ type: "tui.session.select", properties: { sessionID: "ses_tetris" } }])
  assert.equal(api.toasts[0]?.variant, "success")
})

test("focusTuiSession does not target another project instance first", async () => {
  const api = mockApi()
  await focusTuiSession(api, "ses_1", "/tmp/other", "/tmp/current")
  assert.equal(api.selected[0]?.directory, "/tmp/current")
  assert.equal(
    api.selected.some((row) => row.directory === "/tmp/other"),
    false,
  )
})

test("focusTuiSession retries the worker directory if the current TUI rejects", async () => {
  const api = mockApi({ selectError: { message: "NotFound" } })
  const focused = await focusTuiSession(api, "ses_1", "/tmp/other", "/tmp/current")
  assert.equal(focused, true)
  assert.deepEqual(api.selected, [
    { sessionID: "ses_1", directory: "/tmp/current" },
    { sessionID: "ses_1", directory: "/tmp/other" },
  ])
})
