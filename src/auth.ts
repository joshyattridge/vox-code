import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type ApiKeySource = "keychain" | "file" | "plugin" | "env" | "dotenv" | "missing"

export type ResolvedApiKey = {
  key?: string
  source: ApiKeySource
  provider?: string
  hint: string
}

const MISSING_HINT =
  "Voice needs its own OpenAI platform API key. Run `/voice-key` to save one. ChatGPT Plus/Codex OAuth cannot power Realtime."

export function voiceCredentialsFile(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const root = xdg ? xdg : join(homedir(), ".local/share")
  return join(root, "opencode", "vox-code", "credentials.json")
}

export function readVoiceApiKey(file = voiceCredentialsFile()): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { apiKey?: unknown }
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : undefined
  } catch {
    return
  }
}

function readKeychain(): string | undefined {
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", "api-key", "-s", "com.vox-code.openai", "-w"],
      { encoding: "utf8", timeout: 5000 },
    )
    return result.status === 0 ? result.stdout.trim() || undefined : undefined
  }
  if (process.platform === "linux") {
    const result = spawnSync(
      "secret-tool",
      ["lookup", "application", "vox-code", "provider", "openai"],
      { encoding: "utf8", timeout: 5000 },
    )
    return result.status === 0 ? result.stdout.trim() || undefined : undefined
  }
  return
}

function saveKeychain(key: string): boolean {
  if (process.platform === "darwin") {
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return false
    const command = `add-generic-password -U -a api-key -s com.vox-code.openai -l Vox-Code-OpenAI -w ${key}\n`
    return spawnSync("/usr/bin/security", ["-i"], { input: command, encoding: "utf8", timeout: 5000 }).status === 0
  }
  if (process.platform === "linux") {
    const result = spawnSync(
      "secret-tool",
      ["store", "--label=Vox Code OpenAI API key", "application", "vox-code", "provider", "openai"],
      { input: key, encoding: "utf8", timeout: 5000 },
    )
    return result.status === 0
  }
  return false
}

function deleteKeychain(): boolean {
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-a", "api-key", "-s", "com.vox-code.openai"],
      { encoding: "utf8", timeout: 5000 },
    )
    return result.status === 0
  }
  if (process.platform === "linux") {
    const result = spawnSync(
      "secret-tool",
      ["clear", "application", "vox-code", "provider", "openai"],
      { encoding: "utf8", timeout: 5000 },
    )
    return result.status === 0
  }
  return false
}

export function saveVoiceApiKey(apiKey: string, file?: string): "keychain" | "file" {
  const key = apiKey.trim()
  if (!key) throw new Error("Enter an OpenAI API key.")
  if (!file && saveKeychain(key)) {
    const fallback = voiceCredentialsFile()
    if (existsSync(fallback)) unlinkSync(fallback)
    return "keychain"
  }
  const target = file ?? voiceCredentialsFile()
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(target, 0o600)
  return "file"
}

export function removeVoiceApiKey(file?: string): boolean {
  let removed = file ? false : deleteKeychain()
  const target = file ?? voiceCredentialsFile()
  if (existsSync(target)) {
    unlinkSync(target)
    removed = true
  }
  return removed
}

export async function validateOpenAiApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = apiKey.trim()
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("That does not look like an OpenAI platform API key.")
  const response = await fetchImpl("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.ok) return
  let detail = `OpenAI rejected the API key (${response.status}).`
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) detail = body.error.message
  } catch {
    // Keep the status-based message.
  }
  throw new Error(detail)
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readDotEnvKey(directory: string | undefined, envName = "OPENAI_API_KEY"): string | undefined {
  if (!directory) return
  try {
    const text = readFileSync(join(directory, ".env"), "utf8")
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!match || match[1] !== envName) continue
      const value = stripQuotes(match[2] ?? "")
      if (value) return value
    }
  } catch {
    return
  }
}

export function resolveOpenAiApiKey(input: {
  pluginKey?: string
  directory?: string
  env?: NodeJS.ProcessEnv
  voiceKeyFile?: string
} = {}): ResolvedApiKey {
  const keychainKey = input.voiceKeyFile === undefined ? readKeychain() : undefined
  if (keychainKey) {
    return { key: keychainKey, source: "keychain", hint: "Using the API key saved in the OS keychain." }
  }
  const voiceKey = readVoiceApiKey(input.voiceKeyFile)
  if (voiceKey) {
    return { key: voiceKey, source: "file", hint: "Using the private API key file saved by Voice." }
  }

  const pluginKey = input.pluginKey?.trim()
  if (pluginKey) {
    return { key: pluginKey, source: "plugin", hint: "Using plugin apiKey option." }
  }

  const env = input.env ?? process.env
  const fromEnv = env.OPENAI_API_KEY?.trim()
  if (fromEnv) {
    return { key: fromEnv, source: "env", hint: "Using OPENAI_API_KEY from the environment." }
  }

  const fromDotenv = readDotEnvKey(input.directory)
  if (fromDotenv) {
    return { key: fromDotenv, source: "dotenv", hint: "Using OPENAI_API_KEY from the project .env file." }
  }

  return { source: "missing", hint: MISSING_HINT }
}
