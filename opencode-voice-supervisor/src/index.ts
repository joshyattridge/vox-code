import { tool, type PluginModule } from "@opencode-ai/plugin"
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
            `owned sessions: ${state.ownedSessionIds.length ? state.ownedSessionIds.join(", ") : "(none)"}`,
            state.lastUserTranscript ? `heard: ${state.lastUserTranscript}` : undefined,
            state.lastAssistantTranscript ? `said: ${state.lastAssistantTranscript}` : undefined,
            state.error ? `error: ${state.error}` : undefined,
            resolved.apiKey ? "api key: set" : "api key: missing (set OPENAI_API_KEY)",
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
