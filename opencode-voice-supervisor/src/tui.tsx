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

const tui: TuiPlugin = async (api, options) => {
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

  api.command?.register(() => [
    {
      title: "Voice: toggle",
      value: "plugin.voice.toggle",
      category: "Voice",
      keybind: resolved.keybind,
      slash: { name: "voice" },
      onSelect: () => {
        toggle()
      },
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
      title: "Voice: mute",
      value: "plugin.voice.mute",
      category: "Voice",
      slash: { name: "voice-mute" },
      onSelect: () => {
        void supervisor.mute()
      },
    },
    {
      title: "Voice: unmute",
      value: "plugin.voice.unmute",
      category: "Voice",
      slash: { name: "voice-unmute" },
      onSelect: () => {
        void supervisor.unmute()
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
    {
      title: "Voice: panel",
      value: "plugin.voice.panel",
      category: "Voice",
      slash: { name: "voice-panel" },
      onSelect: () => {
        api.route.navigate("voice.supervisor")
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
      home_footer() {
        return <Chip supervisor={supervisor} onToggle={toggle} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
