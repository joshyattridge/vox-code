import assert from "node:assert/strict"
import { test } from "node:test"
import { chipLabel, initialVoiceState } from "../src/types.ts"

test("chip labels match voice phases", () => {
  const state = initialVoiceState()
  assert.equal(chipLabel(state), "○ vox")
  assert.equal(chipLabel({ ...state, phase: "connecting" }), "● VOX")
  assert.equal(chipLabel({ ...state, phase: "connected", realtimeConnected: true }), "● VOX")
  assert.equal(chipLabel({ ...state, phase: "listening", realtimeConnected: true }), "● VOX")
  assert.equal(chipLabel({ ...state, phase: "speaking", realtimeConnected: true }), "● VOX")
  assert.equal(chipLabel({ ...state, phase: "speaking", realtimeConnected: false }), "○ vox")
  assert.equal(chipLabel({ ...state, phase: "error" }), "● error")
})
