/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { attachVoiceDaemon } from "./bridge.ts"
import { focusTuiSession, type TuiFocusApi } from "./focus.ts"
import { extractClientConfig } from "./protocol.ts"
import { voiceLog } from "./log.ts"
import type { SessionClient } from "./client.ts"
import {
  CUSTOM_REALTIME_MODEL,
  LIVE_MODELS,
  REALTIME_MODELS,
  REALTIME_VOICES,
  chipLabel,
  resolveOptions,
} from "./types.ts"
import { defaultSpokenInstructions } from "./instructions.ts"
import type { VoiceSupervisor } from "./supervisor.ts"

const ID = "voice.supervisor"

const currentSessionId = (api: TuiPluginApi) => {
  const route = api.route.current
  if (route.name === "session" && "params" in route) {
    const id = route.params?.sessionID
    return typeof id === "string" ? id : undefined
  }
  return undefined
}

const Chip = (props: { supervisor: VoiceSupervisor; onToggle: () => void }) => {
  const [label, setLabel] = createSignal(chipLabel(props.supervisor.state()))
  const unsub = props.supervisor.subscribe(() => {
    const next = chipLabel(props.supervisor.state())
    if (next !== label()) setLabel(next)
  })
  onCleanup(unsub)
  return (
    <box paddingLeft={1} paddingRight={1} onMouseUp={() => props.onToggle()}>
      <text>{label()}</text>
    </box>
  )
}

const KV_MODEL = "voice.supervisor.model"
const KV_VOICE = "voice.supervisor.voice"
const KV_INSTRUCTIONS = "voice.supervisor.instructions"

const tui: TuiPlugin = async (api, options, meta) => {
  if (options?.enabled === false) return
  const savedModel = api.kv.get<string | undefined>(KV_MODEL, undefined)
  const savedVoice = api.kv.get<string | undefined>(KV_VOICE, undefined)
  const savedInstructions = api.kv.get<string | undefined>(KV_INSTRUCTIONS, undefined)
  const resolved = resolveOptions({
    ...(options ?? {}),
    model: typeof savedModel === "string" && savedModel.trim() ? savedModel : options?.model,
    voice: typeof savedVoice === "string" && savedVoice.trim() ? savedVoice : options?.voice,
    instructions:
      typeof savedInstructions === "string"
        ? savedInstructions.trim() || options?.instructions
        : options?.instructions,
  })
  let supervisor: VoiceSupervisor
  try {
    supervisor = await attachVoiceDaemon({
      directory: api.state.path.directory,
      options: resolved,
      client: extractClientConfig(api.client),
      sessionId: currentSessionId(api),
      sessionClient: api.client as unknown as SessionClient,
      hooks: {
        toast: (input) => api.ui.toast(input),
        onModelChange: (model) => api.kv.set(KV_MODEL, model),
        onVoiceChange: (voice) => api.kv.set(KV_VOICE, voice),
        onInstructionsChange: (instructions) => api.kv.set(KV_INSTRUCTIONS, instructions ?? ""),
        focusSession: async (sessionId, directory) =>
          focusTuiSession(api as unknown as TuiFocusApi, sessionId, directory, api.state.path.directory),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    voiceLog("daemon attach failed", message)
    api.ui.toast({ title: "Voice", message, variant: "error", duration: 8000 })
    return
  }

  let toggling = false
  const toggle = () => {
    if (toggling) return
    toggling = true
    void supervisor.toggle().finally(() => {
      toggling = false
    })
  }

  const pickModel = () => {
    const DialogSelect = api.ui.DialogSelect
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Voice model"
        current={supervisor.model()}
        options={[
          ...LIVE_MODELS.map((model) => ({
            title: model.title,
            value: model.id,
            description: model.description,
            category: "GPT-Live",
          })),
          ...REALTIME_MODELS.map((model) => ({
            title: model.title,
            value: model.id,
            description: model.description,
            category: "Realtime",
          })),
          {
            title: "Custom…",
            value: CUSTOM_REALTIME_MODEL,
            description: "Type a Live or Realtime model id",
            category: "Custom",
          },
        ]}
        onSelect={(option) => {
          const value = String(option.value)
          if (value === CUSTOM_REALTIME_MODEL) {
            api.ui.dialog.replace(() => (
              <DialogPrompt
                title="Custom voice model"
                placeholder="gpt-live-1"
                value={supervisor.model()}
                onConfirm={(id) => {
                  void supervisor.setModel(id)
                  api.ui.dialog.clear()
                }}
                onCancel={() => api.ui.dialog.clear()}
              />
            ))
            return
          }
          void supervisor.setModel(value)
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  const pickVoice = () => {
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Voice speaker"
        current={supervisor.voice()}
        options={REALTIME_VOICES.map((voice) => ({
          title: voice.title,
          value: voice.id,
          description: `${voice.description} · “${voice.sample}”`,
          category: voice.category,
        }))}
        onSelect={(option) => {
          const value = String(option.value)
          api.ui.dialog.clear()
          void (async () => {
            await supervisor.previewVoice(value)
            await supervisor.setVoice(value)
          })()
        }}
      />
    ))
  }

  const pickPrompt = () => {
    const DialogSelect = api.ui.DialogSelect
    const DialogPrompt = api.ui.DialogPrompt
    const custom = Boolean(supervisor.instructions()?.trim())
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Voice prompt"
        current={custom ? "custom" : "default"}
        options={[
          {
            title: "Edit speaking prompt…",
            value: "edit",
            description: custom ? "A custom prompt is active" : "Using the default spoken prompt",
            category: "Prompt",
          },
          {
            title: "Reset to default",
            value: "reset",
            description: "OpenCode voice assistant. Talk out loud.",
            category: "Prompt",
          },
        ]}
        onSelect={(option) => {
          const value = String(option.value)
          if (value === "reset") {
            void supervisor.setInstructions(undefined)
            api.ui.dialog.clear()
            return
          }
          api.ui.dialog.replace(() => (
            <DialogPrompt
              title="How the voice should talk"
              placeholder="How the voice should talk"
              value={supervisor.instructions() ?? defaultSpokenInstructions(supervisor.model())}
              onConfirm={(text) => {
                void supervisor.setInstructions(text)
                api.ui.dialog.clear()
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        }}
      />
    ))
  }

  api.lifecycle.onDispose(() => {
    voiceLog("tui disconnect keep-alive")
    void supervisor.dispose()
  })

  api.event.on("session.idle", (event) => {
    supervisor.handleIdle(event.properties.sessionID)
  })
  api.event.on("tui.session.select", (event) => {
    supervisor.setCurrentSession(event.properties.sessionID)
  })
  api.event.on("session.error", (event) => {
    const sessionId = event.properties.sessionID ?? "unknown"
    const message =
      event.properties.error && "message" in event.properties.error
        ? String(event.properties.error.message)
        : "session error"
    supervisor.handleError(sessionId, message)
  })
  api.event.on("permission.updated", (event) => {
    supervisor.handlePermission(event.properties.sessionID, event.properties.id, event.properties.title)
  })

  // Slash commands, palette rows, and Ctrl+Shift+V come from the keymap.
  // OpenCode's TUI does not load plugins from opencode.json — they must be
  // listed in tui.json and registered here with namespace "palette".
  api.keymap.registerLayer({
    mode: "base",
    commands: [
      {
        name: "voice.toggle",
        title: "Voice: toggle",
        category: "Voice",
        namespace: "palette",
        slashName: "voice",
        suggested: true,
        run: toggle,
      },
      {
        name: "voice.model",
        title: "Voice: model",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-model",
        run: pickModel,
      },
      {
        name: "voice.voice",
        title: "Voice: speaker",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-voice",
        run: pickVoice,
      },
      {
        name: "voice.prompt",
        title: "Voice: prompt",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-prompt",
        run: pickPrompt,
      },
      {
        name: "voice.on",
        title: "Voice: on",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-on",
        run: () => {
          void supervisor.start()
        },
      },
      {
        name: "voice.off",
        title: "Voice: off",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-off",
        run: () => {
          void supervisor.stop()
        },
      },
      {
        name: "voice.status",
        title: "Voice: status",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-status",
        run: () => {
          api.ui.toast({
            title: "Voice",
            message: supervisor.statusText(),
            variant: "info",
            duration: 5000,
          })
        },
      },
    ],
    bindings: [{ key: resolved.keybind, cmd: "voice.toggle", desc: "Toggle voice" }],
  })

  // Prompt `/` autocomplete still uses the legacy command registry in 1.18.
  // Keymap slashName covers ctrl+p; this covers the same `/review`-style list.
  api.command?.register(() => [
    {
      title: "Voice: toggle",
      value: "plugin.voice.toggle",
      category: "Voice",
      keybind: resolved.keybind,
      suggested: true,
      slash: { name: "voice" },
      onSelect: toggle,
    },
    {
      title: "Voice: model",
      value: "plugin.voice.model",
      category: "Voice",
      suggested: true,
      slash: { name: "voice-model" },
      onSelect: pickModel,
    },
    {
      title: "Voice: speaker",
      value: "plugin.voice.voice",
      category: "Voice",
      suggested: true,
      slash: { name: "voice-voice" },
      onSelect: pickVoice,
    },
    {
      title: "Voice: prompt",
      value: "plugin.voice.prompt",
      category: "Voice",
      suggested: true,
      slash: { name: "voice-prompt" },
      onSelect: pickPrompt,
    },
    {
      title: "Voice: on",
      value: "plugin.voice.on",
      category: "Voice",
      slash: { name: "voice-on" },
      onSelect: () => {
        void supervisor.start()
      },
    },
    {
      title: "Voice: off",
      value: "plugin.voice.off",
      category: "Voice",
      slash: { name: "voice-off" },
      onSelect: () => {
        void supervisor.stop()
      },
    },
    {
      title: "Voice: status",
      value: "plugin.voice.status",
      category: "Voice",
      slash: { name: "voice-status" },
      onSelect: () => {
        api.ui.toast({
          title: "Voice",
          message: supervisor.statusText(),
          variant: "info",
          duration: 5000,
        })
      },
    },
  ])

  api.slots.register({
    slots: {
      home_prompt_right() {
        return <Chip supervisor={supervisor} onToggle={toggle} />
      },
      session_prompt_right() {
        return <Chip supervisor={supervisor} onToggle={toggle} />
      },
    },
  })

  api.ui.toast({
    title: "Voice",
    message: "Click ○ voice, or ctrl+p then Voice. /voice-voice plays a speaker sample. /voice-prompt edits how it talks.",
    variant: meta.state === "first" ? "success" : "info",
    duration: 6000,
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
