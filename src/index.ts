import { tool, type PluginModule } from "@opencode-ai/plugin"
import { resolveOpenAiApiKey } from "./auth.ts"
import { readPersistedVoiceState } from "./persist.ts"
import { resolveOptions } from "./types.ts"

const ID = "voice.code"

const server: PluginModule["server"] = async (input, options) => {
  const resolved = resolveOptions(options)

  void input.client.app.log({
    body: { service: ID, level: "info", message: `loaded in ${input.directory}` },
  })

  return {
    tool: {
      voice_status: tool({
        description: "Show the Voice chip state, connection, and owned worker sessions.",
        args: {},
        async execute() {
          const state = readPersistedVoiceState()
          const activeMs =
            (state.completedActiveMs ?? 0) + (state.connectedSince ? Date.now() - state.connectedSince : 0)
          const formatDuration = (milliseconds: number) => {
            const seconds = Math.max(0, Math.floor(milliseconds / 1000))
            return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
          }
          return [
            `chip: ${state.chip}`,
            `phase: ${state.phase}`,
            `realtime: ${state.realtimeConnected ? "connected" : "down"}`,
            `desired: ${state.desiredOn ? "on" : "off"}`,
            state.sessionStartedAt ? `active: ${formatDuration(activeMs)}` : undefined,
             `model: ${state.model ?? resolved.model}`,
             `voice: ${state.voice ?? resolved.voice}`,
             `prompt: ${(state.customInstructions ?? Boolean(resolved.instructions)) ? "custom" : "default"}`,
            `owned sessions: ${state.ownedSessionIds.length ? state.ownedSessionIds.join(", ") : "(none)"}`,
            state.lastUserTranscript ? `heard: ${state.lastUserTranscript}` : undefined,
            state.lastAssistantTranscript ? `said: ${state.lastAssistantTranscript}` : undefined,
            state.error ? `error: ${state.error}` : undefined,
            (() => {
              const key = resolveOpenAiApiKey({
                pluginKey: resolved.apiKey,
                directory: input.directory,
              })
              return key.key ? `api key: ${key.source}` : `api key: missing — ${key.hint}`
            })(),
            "Set the Voice-only OpenAI key with /voice-key, then turn it on with /voice or Ctrl+Shift+V.",
          ]
            .filter(Boolean)
            .join("\n")
        },
      }),
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: ID,
  server,
}

export default plugin
