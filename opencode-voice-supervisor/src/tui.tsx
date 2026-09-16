/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createVoiceSupervisor, type VoiceSupervisor } from "./supervisor.ts"
import { chipLabel, resolveOptions } from "./types.ts"
import type { SessionClient } from "./client.ts"

const ID = "voice.supervisor"

const currentSessionId = (api: TuiPluginApi) => {
  const route = api.route.current
  if (route.name === "session" && "params" in route) return route.params.sessionID
  return undefined
}

const Panel = (props: { supervisor: VoiceSupervisor }) => {
  const [text, setText] = createSignal(props.supervisor.statusText())
  const unsub = props.supervisor.subscribe(() => setText(props.supervisor.statusText()))
  onCleanup(unsub)
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <text>Voice supervisor</text>
      <text>{text()}</text>
      <text>/voice toggle · /voice-mute · /voice-panel</text>
    </box>
  )
}

const Chip = (props: { supervisor: VoiceSupervisor; onToggle: () => void }) => {
  const [label, setLabel] = createSignal(chipLabel(props.supervisor.state()))
  const unsub = props.supervisor.subscribe(() => setLabel(chipLabel(props.supervisor.state())))
  onCleanup(unsub)
  return (
    <box paddingLeft={1} paddingRight={1} onMouseUp={() => props.onToggle()}>
      <text>{label()}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api, options, meta) => {
  if (options?.enabled === false) return
  const resolved = resolveOptions(options)
  const supervisor = createVoiceSupervisor({
    client: api.client as unknown as SessionClient,
    options: resolved,
    directory: api.state.path.directory,
    hooks: {
      toast: (input) => api.ui.toast(input),
      currentSessionId: () => currentSessionId(api),
      focusSession: (sessionId) => {
        api.route.navigate("session", { sessionID: sessionId })
        return true
      },
    },
  })

  const toggle = () => {
    void supervisor.toggle()
  }

  api.lifecycle.onDispose(() => {
    void supervisor.dispose()
  })

  api.event.on("session.idle", (event) => {
    supervisor.handleIdle(event.properties.sessionID)
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

  api.route.register([
    {
      name: "voice.supervisor",
      render: () => <Panel supervisor={supervisor} />,
    },
  ])

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
        name: "voice.mute",
        title: "Voice: mute",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-mute",
        run: () => {
          void supervisor.mute()
        },
      },
      {
        name: "voice.unmute",
        title: "Voice: unmute",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-unmute",
        run: () => {
          void supervisor.unmute()
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
      {
        name: "voice.panel",
        title: "Voice: panel",
        category: "Voice",
        namespace: "palette",
        slashName: "voice-panel",
        run: () => {
          api.route.navigate("voice.supervisor")
        },
      },
    ],
    bindings: [{ key: resolved.keybind, cmd: "voice.toggle", desc: "Toggle voice" }],
  })

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
    message: "○ voice is in the prompt row. Type /voice or Ctrl+Shift+V.",
    variant: meta.state === "first" ? "success" : "info",
    duration: 6000,
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
