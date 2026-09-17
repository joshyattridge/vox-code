import assert from "node:assert/strict"
import { test } from "node:test"
import { chipLabel, initialVoiceState } from "../src/types.ts"

test("chip labels match voice phases", () => {
  const state = initialVoiceState()
  assert.equal(chipLabel(state), "○ voice")
  assert.equal(chipLabel({ ...state, phase: "connecting" }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "connected", realtimeConnected: true }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "listening", realtimeConnected: true }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "speaking", realtimeConnected: true }), "● VOICE")
  assert.equal(chipLabel({ ...state, phase: "speaking", realtimeConnected: false }), "○ voice")
  assert.equal(chipLabel({ ...state, phase: "error" }), "● error")
})
