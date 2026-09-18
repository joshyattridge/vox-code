import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { chipLabel, initialVoiceState, normalizeVoiceState, type VoiceUiState } from "./types.ts"

export type PersistedVoiceState = VoiceUiState & {
  chip: string
  updatedAt: number
  ownerPid?: number
}

export function stateFilePath(): string {
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local/share"), "opencode/vox-code/state.json")
}

export function daemonSockPath() {
  return process.env.VOICE_SOCK ?? stateFilePath().replace(/state\.json$/, "vox.sock")
}

export function daemonPidPath() {
  return stateFilePath().replace(/state\.json$/, "vox.pid")
}

export function persistVoiceState(state: VoiceUiState): void {
  const file = stateFilePath()
  const normalized = normalizeVoiceState(state)
  const payload: PersistedVoiceState = {
    ...normalized,
    chip: chipLabel(normalized),
    updatedAt: Date.now(),
    ownerPid: process.pid,
  }
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } catch {
    // Diagnostics must never take down the audio session (e.g. a full disk).
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

export function readPersistedVoiceState(): PersistedVoiceState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), "utf8")) as Partial<PersistedVoiceState>
    if (parsed.ownerPid) {
      try { process.kill(parsed.ownerPid, 0) } catch {
        parsed.realtimeConnected = false
        parsed.desiredOn = false
        parsed.phase = "off"
        parsed.connectedSince = undefined
      }
    }
    const base = initialVoiceState()
    const normalized = normalizeVoiceState({
      ...base,
      ...parsed,
      ownedSessionIds: parsed.ownedSessionIds ?? [],
      realtimeConnected: Boolean(parsed.realtimeConnected),
      phase: (parsed.phase as string) === "muted" ? (parsed.realtimeConnected ? "connected" : "off") : parsed.phase ?? "off",
    })
    return {
      ...normalized,
      chip: chipLabel(normalized),
      updatedAt: parsed.updatedAt ?? 0,
    }
  } catch {
    const base = initialVoiceState()
    return { ...base, chip: chipLabel(base), updatedAt: 0 }
  }
}
