import assert from "node:assert/strict"
import { test } from "node:test"
import { encodeMessage, extractClientConfig, splitMessages } from "../src/protocol.ts"

test("splitMessages parses JSONL and keeps a partial trailing line", () => {
  const { messages, rest } = splitMessages(`${encodeMessage({ type: "ready" })}{"type":"to`)
  assert.deepEqual(messages, [{ type: "ready" }])
  assert.equal(rest, `{"type":"to`)
})

test("extractClientConfig walks nested OpenCode SDK clients", () => {
  const cfg = extractClientConfig({
    session: {},
    client: {
      getConfig() {
        return {
          baseUrl: "http://127.0.0.1:4096",
          headers: { authorization: "Bearer test" },
        }
      },
    },
  })
  assert.equal(cfg.baseUrl, "http://127.0.0.1:4096")
  assert.equal(cfg.headers?.authorization, "Bearer test")
})

test("extractClientConfig uses buildUrl when getConfig is missing", () => {
  const cfg = extractClientConfig({
    buildUrl({ url }: { url: string }) {
      return `http://127.0.0.1:4096${url}`
    },
  })
  assert.equal(cfg.baseUrl, "http://127.0.0.1:4096")
})
