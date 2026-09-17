import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { stateFilePath } from "./persist.ts"

export function voiceLogPath() {
  return stateFilePath().replace(/state\.json$/, "voice.log")
}

export function voiceLog(message: string, extra?: unknown) {
  if (process.env.NODE_TEST_CONTEXT) return
  try {
    const file = voiceLogPath()
    mkdirSync(dirname(file), { recursive: true })
    const detail = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`
    appendFileSync(file, `${new Date().toISOString()} ${message}${detail}\n`)
  } catch {
    // never throw from diagnostics
  }
}
