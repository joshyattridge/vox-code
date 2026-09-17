import assert from "node:assert/strict"
import { test } from "node:test"
import { chipLabel, initialVoiceState } from "../src/types.ts"

test("chip labels match voice phases", () => {
  const state = initialVoiceState()
  assert.equal(chipLabel(state), "○ voice")
  assert.equal(chipLabel({ ...state, phase: "connecting" }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "connected", realtimeConnected: true }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "listening" }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "speaking" }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "muted" }), "● muted")
  assert.equal(chipLabel({ ...state, phase: "error" }), "● error")
})
