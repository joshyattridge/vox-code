import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readVoiceApiKey,
  removeVoiceApiKey,
  resolveOpenAiApiKey,
  saveVoiceApiKey,
  validateOpenAiApiKey,
} from "../src/auth.ts"

test("saves and resolves a Voice-only API key with private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const voiceKeyFile = join(dir, "vox", "credentials.json")
  saveVoiceApiKey(" sk-vox ", voiceKeyFile)
  const resolved = resolveOpenAiApiKey({
    env: {},
    voiceKeyFile,
  })
  assert.equal(readVoiceApiKey(voiceKeyFile), "sk-vox")
  assert.equal(resolved.key, "sk-vox")
  assert.equal(resolved.source, "file")
  assert.equal(statSync(voiceKeyFile).mode & 0o777, 0o600)
})

test("Voice key overrides legacy plugin and environment configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const voiceKeyFile = join(dir, "credentials.json")
  saveVoiceApiKey("sk-vox", voiceKeyFile)
  const resolved = resolveOpenAiApiKey({
    pluginKey: "sk-option",
    env: { OPENAI_API_KEY: "sk-env" },
    voiceKeyFile,
  })
  assert.equal(resolved.key, "sk-vox")
  assert.equal(resolved.source, "file")
})

test("falls back to the legacy plugin option and environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const voiceKeyFile = join(dir, "missing.json")
  const plugin = resolveOpenAiApiKey({
    pluginKey: "sk-option",
    env: { OPENAI_API_KEY: "sk-env" },
    voiceKeyFile,
  })
  const env = resolveOpenAiApiKey({ env: { OPENAI_API_KEY: "sk-env" }, voiceKeyFile })
  assert.equal(plugin.source, "plugin")
  assert.equal(env.source, "env")
})

test("missing key points to the Voice command rather than OpenCode auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const resolved = resolveOpenAiApiKey({ env: {}, voiceKeyFile: join(dir, "missing.json") })
  assert.equal(resolved.source, "missing")
  assert.match(resolved.hint, /\/voice-key/)
  assert.doesNotMatch(resolved.hint, /opencode auth login/)
})

test("removes a saved private-file key", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-auth-"))
  const voiceKeyFile = join(dir, "credentials.json")
  saveVoiceApiKey("sk-abcdefghijklmnopqrstuvwxyz", voiceKeyFile)
  assert.equal(removeVoiceApiKey(voiceKeyFile), true)
  assert.equal(readVoiceApiKey(voiceKeyFile), undefined)
  assert.equal(removeVoiceApiKey(voiceKeyFile), false)
})

test("validates an API key before storage", async () => {
  const calls: string[] = []
  await validateOpenAiApiKey("sk-abcdefghijklmnopqrstuvwxyz", async (url, init) => {
    calls.push(String(url), String((init?.headers as Record<string, string>).Authorization))
    return new Response("{}", { status: 200 })
  })
  assert.equal(calls[0], "https://api.openai.com/v1/models")
  assert.match(calls[1] ?? "", /^Bearer sk-/)

  await assert.rejects(
    validateOpenAiApiKey(
      "sk-abcdefghijklmnopqrstuvwxyz",
      async () => new Response(JSON.stringify({ error: { message: "Invalid key" } }), { status: 401 }),
    ),
    /Invalid key/,
  )
})
