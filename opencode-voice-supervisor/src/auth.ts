import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ApiKeySource = "plugin" | "opencode-auth" | "env" | "dotenv" | "missing"

export type ResolvedApiKey = {
  key?: string
  source: ApiKeySource
  provider?: string
  hint: string
}

type AuthEntry = {
  type?: string
  key?: string
  token?: string
}

const MISSING_HINT =
  "No OpenAI API key in OpenCode. Run `opencode auth login` (OpenAI → API key) or `/connect`. ChatGPT/Codex OAuth cannot power Realtime. OPENAI_API_KEY is also accepted if OpenCode already uses it."

export function defaultAuthFile(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const root = xdg ? xdg : join(homedir(), ".local/share")
  return join(root, "opencode", "auth.json")
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

function readJsonFile(path: string): Record<string, AuthEntry> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    return parsed as Record<string, AuthEntry>
  } catch {
    return
  }
}

function keyFromEntry(entry: AuthEntry | undefined): string | undefined {
  if (!entry || entry.type === "oauth") return
  if (typeof entry.key === "string" && entry.key.trim()) return entry.key.trim()
  if (entry.type === "wellknown" && typeof entry.token === "string" && entry.token.trim()) {
    return entry.token.trim()
  }
  return
}

export function readOpenCodeAuthKey(
  authFile = defaultAuthFile(),
  providerIds: string[] = ["openai"],
): { key?: string; provider?: string; oauthOnly?: boolean } {
  const store = readJsonFile(authFile)
  if (!store) return {}
  let oauthOnly = false
  for (const id of providerIds) {
    const entry = store[id]
    const key = keyFromEntry(entry)
    if (key) return { key, provider: id }
    if (entry?.type === "oauth") oauthOnly = true
  }
  return { oauthOnly }
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
  authFile?: string
} = {}): ResolvedApiKey {
  const pluginKey = input.pluginKey?.trim()
  if (pluginKey) {
    return { key: pluginKey, source: "plugin", hint: "Using plugin apiKey option." }
  }

  const fromAuth = readOpenCodeAuthKey(input.authFile ?? defaultAuthFile())
  if (fromAuth.key) {
    return {
      key: fromAuth.key,
      source: "opencode-auth",
      provider: fromAuth.provider,
      hint: `Using OpenCode ${fromAuth.provider} API key from auth.json.`,
    }
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

  const hint = fromAuth.oauthOnly
    ? "OpenCode has an OpenAI OAuth login, but Realtime needs a platform API key. Run `opencode auth login` and choose OpenAI → API key."
    : MISSING_HINT
  return { source: "missing", hint }
}
