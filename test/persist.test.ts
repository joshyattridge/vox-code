import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { persistVoiceState, readPersistedVoiceState, stateFilePath } from "../src/persist.ts"

test("persisted state includes the chip label", () => {
  persistVoiceState({
    phase: "listening",
    realtimeConnected: true,
    ownedSessionIds: ["ses_1"],
    lastUserTranscript: "write tests",
  })
  const saved = readPersistedVoiceState()
  assert.equal(saved.chip, "● VOX")
  assert.equal(saved.ownedSessionIds[0], "ses_1")
  assert.equal(typeof saved.updatedAt, "number")
  const file = stateFilePath()
  assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "listening")
  assert.ok(file.includes("vox-code"))
})

test("stale speaking state without a live socket is stored as off", () => {
  persistVoiceState({
    phase: "speaking",
    realtimeConnected: false,
    ownedSessionIds: [],
  })
  const saved = readPersistedVoiceState()
  assert.equal(saved.phase, "off")
  assert.equal(saved.chip, "○ vox")
})
