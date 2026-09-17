import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { chipLabel, initialVoiceState, normalizeVoiceState, type VoiceUiState } from "./types.ts"

export type PersistedVoiceState = VoiceUiState & {
  chip: string
  updatedAt: number
}

export function stateFilePath(): string {
  return join(homedir(), ".local/share/opencode/vox-code/state.json")
}

export function daemonSockPath() {
  return process.env.VOX_SOCK ?? process.env.VOICE_SOCK ?? stateFilePath().replace(/state\.json$/, "vox.sock")
}

export function daemonPidPath() {
  return stateFilePath().replace(/state\.json$/, "vox.pid")
}

export function persistVoiceState(state: VoiceUiState): void {
  const file = stateFilePath()
  mkdirSync(dirname(file), { recursive: true })
  const normalized = normalizeVoiceState(state)
  const payload: PersistedVoiceState = {
    ...normalized,
    chip: chipLabel(normalized),
    updatedAt: Date.now(),
  }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
}

export function readPersistedVoiceState(): PersistedVoiceState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), "utf8")) as Partial<PersistedVoiceState>
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
