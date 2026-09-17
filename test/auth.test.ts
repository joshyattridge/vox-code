import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveOpenAiApiKey } from "../src/auth.ts"

test("reads the OpenAI API key from OpenCode auth.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const authFile = join(dir, "auth.json")
  writeFileSync(
    authFile,
    JSON.stringify({ openai: { type: "api", key: "sk-from-opencode" } }),
  )
  const resolved = resolveOpenAiApiKey({
    env: {},
    authFile,
  })
  assert.equal(resolved.key, "sk-from-opencode")
  assert.equal(resolved.source, "opencode-auth")
})

test("plugin option overrides OpenCode auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const authFile = join(dir, "auth.json")
  writeFileSync(authFile, JSON.stringify({ openai: { type: "api", key: "sk-stored" } }))
  const resolved = resolveOpenAiApiKey({
    pluginKey: "sk-option",
    env: { OPENAI_API_KEY: "sk-env" },
    authFile,
  })
  assert.equal(resolved.key, "sk-option")
  assert.equal(resolved.source, "plugin")
})

test("falls back to OPENAI_API_KEY when auth.json has no api key", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const authFile = join(dir, "auth.json")
  writeFileSync(authFile, JSON.stringify({ openai: { type: "oauth", access: "tok" } }))
  const resolved = resolveOpenAiApiKey({
    env: { OPENAI_API_KEY: "sk-env" },
    authFile,
  })
  assert.equal(resolved.key, "sk-env")
  assert.equal(resolved.source, "env")
})

test("explains that ChatGPT OAuth cannot power Realtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const authFile = join(dir, "auth.json")
  writeFileSync(authFile, JSON.stringify({ openai: { type: "oauth", access: "tok" } }))
  const resolved = resolveOpenAiApiKey({ env: {}, authFile })
  assert.equal(resolved.source, "missing")
  assert.match(resolved.hint, /OAuth/)
})
