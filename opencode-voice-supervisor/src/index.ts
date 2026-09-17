import { tool, type PluginModule } from "@opencode-ai/plugin"
import { resolveOpenAiApiKey } from "./auth.ts"
import { readPersistedVoiceState } from "./persist.ts"
import { resolveOptions } from "./types.ts"

const ID = "voice.supervisor"

const server: PluginModule["server"] = async (input, options) => {
  const resolved = resolveOptions(options)

  void input.client.app.log({
    body: { service: ID, level: "info", message: `loaded in ${input.directory}` },
  })

  return {
    tool: {
      voice_status: tool({
        description: "Show the OpenCode voice supervisor chip state, connection, and owned worker sessions.",
        args: {},
        async execute() {
          const state = readPersistedVoiceState()
          return [
            `chip: ${state.chip}`,
            `phase: ${state.phase}`,
            `realtime: ${state.realtimeConnected ? "connected" : "down"}`,
            `model: ${resolved.model}`,
            `voice: ${resolved.voice}`,
            `prompt: ${resolved.instructions ? "custom" : "default"}`,
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
            "Turn voice on from the TUI with /voice or Ctrl+Shift+V.",
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
