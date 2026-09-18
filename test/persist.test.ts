import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { persistVoiceState, readPersistedVoiceState, stateFilePath } from "../src/persist.ts"

test("persisted state includes the chip label", () => {
  persistVoiceState({
    phase: "listening",
    realtimeConnected: true,
    desiredOn: true,
    ownedSessionIds: ["ses_1"],
    lastUserTranscript: "write tests",
  })
  const saved = readPersistedVoiceState()
  assert.equal(saved.chip, "● VOICE")
  assert.equal(saved.ownedSessionIds[0], "ses_1")
  assert.equal(typeof saved.updatedAt, "number")
  const file = stateFilePath()
  assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "listening")
  assert.ok(file.includes("vox-code"))
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("persisted status from a dead daemon is shown as off", () => {
  persistVoiceState({ phase: "speaking", realtimeConnected: true, desiredOn: true, ownedSessionIds: [] })
  const file = stateFilePath()
  const state = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...state, ownerPid: 2147483647 }))
  assert.equal(readPersistedVoiceState().phase, "off")
  assert.equal(readPersistedVoiceState().desiredOn, false)
})

test("stale speaking state without a live socket is stored as off", () => {
  persistVoiceState({
    phase: "speaking",
    realtimeConnected: false,
    desiredOn: false,
    ownedSessionIds: [],
  })
  const saved = readPersistedVoiceState()
  assert.equal(saved.phase, "off")
  assert.equal(saved.chip, "○ voice")
})
