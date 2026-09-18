import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const MESSAGE_LIMIT = 6
const MESSAGE_TEXT_LIMIT = 1000
const TOTAL_TEXT_LIMIT = 4000
const FILE_LIMIT = 20

function truncate(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false }
  if (limit <= 3) return { text: text.slice(0, limit), truncated: true }
  return { text: `${text.slice(0, limit - 3)}...`, truncated: true }
}

export function collectCurrentContext(api: TuiPluginApi) {
  const route = api.route.current
  const sessionID =
    route.name === "session" && "params" in route && typeof route.params?.sessionID === "string"
      ? route.params.sessionID
      : undefined
  const result: Record<string, unknown> = {
    version: 1,
    capturedAt: Date.now(),
    route: { name: route.name, sessionID },
    location: {
      directory: api.state.path.directory,
      worktree: api.state.path.worktree,
      branch: api.state.vcs?.branch,
      defaultBranch: api.state.vcs?.default_branch,
    },
    draft: { available: false, reason: "tui-prompt-ref-not-exposed" },
    visible: {
      available: false,
      panel: null,
      file: null,
      diff: null,
      terminal: null,
      reason: "tui-view-state-not-exposed",
    },
  }
  if (!sessionID) return result

  const session = api.state.session.get(sessionID)
  const status = api.state.session.status(sessionID)
  result.session = {
    id: sessionID,
    title: session?.title ? truncate(session.title, 200).text : undefined,
    directory: session?.directory,
    status: status?.type,
  }

  const allMessages = api.state.session.messages(sessionID)
  const recent = allMessages.slice(-MESSAGE_LIMIT)
  let remaining = TOTAL_TEXT_LIMIT
  const items: Array<Record<string, unknown>> = []
  for (const message of recent) {
    if (remaining <= 0) break
    const text = api.state
      .part(message.id)
      .flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])
      .join("\n")
      .trim()
    if (!text) continue
    const bounded = truncate(text, Math.min(MESSAGE_TEXT_LIMIT, remaining))
    remaining -= bounded.text.length
    items.push({
      id: message.id,
      role: message.role,
      created: message.time.created,
      text: bounded.text,
      textTruncated: bounded.truncated,
    })
  }
  result.messages = {
    totalCached: allMessages.length,
    returned: items.length,
    truncated: allMessages.length > recent.length || recent.length > items.length || remaining <= 0,
    items,
  }

  const changes = api.state.session.diff(sessionID)
  const files = changes.slice(0, FILE_LIMIT).map((change) => ({
    path: truncate(change.file, 512).text,
    additions: change.additions,
    deletions: change.deletions,
  }))
  result.sessionChanges = {
    total: changes.length,
    returned: files.length,
    truncated: changes.length > files.length,
    files,
  }

  const latest = [...recent].reverse()
  const user = latest.find((message) => message.role === "user")
  const assistant = latest.find((message) => message.role === "assistant")
  if (session?.model) {
    result.model = { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant, source: "session" }
  } else if (user?.role === "user") {
    result.model = { ...user.model, source: "last-user-message" }
  } else if (assistant?.role === "assistant") {
    result.model = {
      providerID: assistant.providerID,
      modelID: assistant.modelID,
      variant: assistant.variant,
      source: "last-assistant-message",
    }
  } else if (api.state.config.model) {
    const [providerID, modelID] = api.state.config.model.split("/")
    result.model = { providerID, modelID: modelID ?? providerID, source: "config" }
  }
  return result
}
