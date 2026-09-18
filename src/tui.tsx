/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, onMount } from "solid-js"
import type { InputRenderable } from "@opentui/core"
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
import { resolveOpenAiApiKey } from "./auth.ts"
import { collectCurrentContext } from "./context.ts"

const ID = "voice.code"

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

const ApiKeyDialog = (props: { api: TuiPluginApi; onConfirm: (apiKey: string) => void }) => {
  const [length, setLength] = createSignal(0)
  let input: InputRenderable | undefined
  const theme = props.api.theme.current

  onMount(() => {
    props.api.ui.dialog.setSize("medium")
    setTimeout(() => input?.focus(), 1)
  })
  onCleanup(() => {
    input?.setText("")
    setLength(0)
  })

  const submit = (value: string) => {
    const key = value.trim()
    if (!key) return
    input?.setText("")
    setLength(0)
    props.api.ui.dialog.clear()
    props.onConfirm(key)
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text}>Voice OpenAI API key</text>
      <text fg={theme.textMuted}>The key is hidden and will be validated before it is saved.</text>
      <input
        ref={(value) => (input = value)}
        width="100%"
        focused
        selectable={false}
        showCursor={false}
        textColor={theme.backgroundPanel}
        focusedTextColor={theme.backgroundPanel}
        selectionFg={theme.backgroundPanel}
        onInput={(value) => setLength(Array.from(value).length)}
        onSubmit={submit as never}
        onKeyDown={(key) => {
          if (key.name === "escape") props.api.ui.dialog.clear()
        }}
      />
      <text fg={length() ? theme.text : theme.textMuted}>
        {length() ? "•".repeat(length()) : "sk-..."}
      </text>
      <text fg={theme.textMuted}>enter submit · esc cancel</text>
    </box>
  )
}

const KV_MODEL = "voice.code.model"
const KV_VOICE = "voice.code.voice"
const KV_INSTRUCTIONS = "voice.code.instructions"

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
        ? savedInstructions.trim() || undefined
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
        currentContext: () => collectCurrentContext(api),
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

  const enterApiKey = () => {
    api.ui.dialog.replace(() => (
      <ApiKeyDialog api={api} onConfirm={(apiKey) => void supervisor.setApiKey(apiKey)} />
    ))
  }

  const manageApiKey = () => {
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="Voice API key"
        options={[
          {
            title: "Add or replace key…",
            value: "replace",
            description: "Enter a masked OpenAI platform API key",
          },
          {
            title: "Status",
            value: "status",
            description: "Show where the current key comes from without revealing it",
          },
          {
            title: "Remove saved key",
            value: "remove",
            description: "Delete the Voice key from secure storage",
          },
        ]}
        onSelect={(option) => {
          const value = String(option.value)
          if (value === "replace") {
            enterApiKey()
            return
          }
          api.ui.dialog.clear()
          if (value === "remove") {
            void supervisor.removeApiKey()
            return
          }
          const status = resolveOpenAiApiKey({
            pluginKey: resolved.apiKey,
            directory: api.state.path.directory,
          })
          api.ui.toast({
            title: "Voice",
            message: status.key ? `API key configured via ${status.source}.` : status.hint,
            variant: status.key ? "success" : "warning",
          })
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
  api.event.on("permission.asked", (event) => {
    const { sessionID, id, permission, patterns } = event.properties
    const title = patterns.length ? `${permission}: ${patterns.join(", ")}` : permission
    supervisor.handlePermission(sessionID, id, title)
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
        name: "voice.speaker",
        title: "Voice: speaker",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-speaker",
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
        name: "voice.key",
        title: "Voice: API key",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-key",
        run: manageApiKey,
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
    bindings: [{ key: resolved.keybind, cmd: "voice.toggle", desc: "Toggle Voice" }],
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
      value: "plugin.voice.speaker",
      category: "Voice",
      suggested: true,
      slash: { name: "voice-speaker" },
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
      title: "Voice: API key",
      value: "plugin.voice.key",
      category: "Voice",
      suggested: true,
      slash: { name: "voice-key" },
      onSelect: manageApiKey,
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
    message: "Click ○ voice, or ctrl+p then Voice. Use /voice-key to save the API key.",
    variant: meta.state === "first" ? "success" : "info",
    duration: 6000,
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
