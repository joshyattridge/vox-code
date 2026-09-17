import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { chipLabel, initialVoiceState, type VoiceUiState } from "./types.ts"

export type PersistedVoiceState = VoiceUiState & {
  chip: string
  updatedAt: number
}

export function stateFilePath(): string {
  return join(homedir(), ".local/share/opencode/voice-supervisor/state.json")
}

export function daemonSockPath() {
  return process.env.VOICE_SOCK ?? stateFilePath().replace(/state\.json$/, "voice.sock")
}

export function daemonPidPath() {
  return stateFilePath().replace(/state\.json$/, "voice.pid")
}

export function persistVoiceState(state: VoiceUiState): void {
  const file = stateFilePath()
  mkdirSync(dirname(file), { recursive: true })
  const payload: PersistedVoiceState = {
    ...state,
    chip: chipLabel(state),
    updatedAt: Date.now(),
  }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
}

export function readPersistedVoiceState(): PersistedVoiceState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), "utf8")) as Partial<PersistedVoiceState>
    const base = initialVoiceState()
    return {
      ...base,
      ...parsed,
      chip: parsed.chip ?? chipLabel({ ...base, ...parsed } as VoiceUiState),
      updatedAt: parsed.updatedAt ?? 0,
      ownedSessionIds: parsed.ownedSessionIds ?? [],
      realtimeConnected: Boolean(parsed.realtimeConnected),
      muted: Boolean(parsed.muted),
      phase: parsed.phase ?? "off",
    }
  } catch {
    const base = initialVoiceState()
    return { ...base, chip: chipLabel(base), updatedAt: 0 }
  }
}
