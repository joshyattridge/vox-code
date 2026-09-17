import { voiceLog } from "./log.ts"
import type { SessionController } from "./sessions.ts"

export type ToolContext = {
  currentSessionId?: string
  warnSharedCheckout?: boolean
  directory?: string
}

export type ToolContextInput = ToolContext | (() => ToolContext)

export function resolveToolContext(ctx?: ToolContextInput): ToolContext {
  if (!ctx) return {}
  return typeof ctx === "function" ? ctx() : ctx
}

export type ToolResult = {
  name: string
  output: unknown
}

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "list_sessions",
    description: "List OpenCode sessions, including workers this supervisor created.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "create_session",
    description:
      "Create a worker OpenCode session, optionally prompt it, and focus it in the TUI so the user can watch. Omit directory to use the current project. For a new folder in the user's home, pass a path like /Users/<name>/pong — never /home, /root, /workspace, or /tmp unless they asked for that path. Missing folders are created. Vox Code keeps running if the TUI switches projects.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the session" },
        directory: {
          type: "string",
          description: "Absolute project directory or git worktree for this worker",
        },
        prompt: {
          type: "string",
          description: "Optional coding prompt to send immediately after create. Prefer this over a second prompt_session call.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "prompt_session",
    description:
      "Send a coding prompt to a worker session and return immediately. Use session_id current to target the focused TUI session.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["session_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "abort_session",
    description: "Abort a running worker session.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "session_status",
    description:
      "Get worker status plus its last assistant message. idle/unknown with lastMessage means the work finished — speak that result. Do not prompt the worker again for a status report.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "reply_permission",
    description: "Answer a pending OpenCode permission prompt for a worker session.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        permission_id: { type: "string" },
        reply: { type: "string", enum: ["once", "always", "reject"] },
      },
      required: ["session_id", "permission_id", "reply"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus_session",
    description:
      "Focus a session in the OpenCode TUI, including a worker in another folder. The voice daemon keeps running if the TUI switches projects.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
] as const

export type FocusHandler = (sessionId: string, directory?: string) => boolean | Promise<boolean>

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  sessions: SessionController,
  ctx: ToolContext,
  focus?: FocusHandler,
): Promise<ToolResult> {
  voiceLog("tool", { name, args })
  try {
    const result = await runTool(name, args, sessions, ctx, focus)
    voiceLog("tool ok", { name, output: result.output })
    return result
  } catch (error) {
    voiceLog("tool error", { name, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  sessions: SessionController,
  ctx: ToolContext,
  focus?: FocusHandler,
): Promise<ToolResult> {
  switch (name) {
    case "list_sessions": {
      const list = await sessions.list()
      return { name, output: { sessions: list } }
    }
    case "create_session": {
      const title = typeof args.title === "string" ? args.title : undefined
      const directory = typeof args.directory === "string" ? args.directory : undefined
      const prompt = typeof args.prompt === "string" ? args.prompt : undefined
      const created = await sessions.create({ title, directory })
      const warning =
        !directory && ctx.warnSharedCheckout
          ? "This worker shares the same checkout as other sessions. Parallel file edits may collide."
          : undefined
      let prompted = false
      if (prompt?.trim()) {
        await sessions.prompt(created.id, prompt)
        prompted = true
      }
      let focused = false
      if (focus) {
        focused = Boolean(await focus(created.id, created.directory))
      }
      return { name, output: { ...created, warning, focused, prompted } }
    }
    case "prompt_session": {
      const sessionId = sessions.resolve(String(args.session_id), ctx.currentSessionId)
      const prompt = String(args.prompt ?? "")
      if (!prompt.trim()) throw new Error("prompt_session requires a prompt")
      const result = await sessions.prompt(sessionId, prompt)
      return { name, output: result }
    }
    case "abort_session": {
      const sessionId = sessions.resolve(String(args.session_id), ctx.currentSessionId)
      return { name, output: await sessions.abort(sessionId) }
    }
    case "session_status": {
      const sessionId = sessions.resolve(String(args.session_id), ctx.currentSessionId)
      return { name, output: await sessions.status(sessionId) }
    }
    case "reply_permission": {
      const sessionId = sessions.resolve(String(args.session_id), ctx.currentSessionId)
      const permissionId = String(args.permission_id)
      const reply = args.reply
      if (reply !== "once" && reply !== "always" && reply !== "reject") {
        throw new Error("reply must be once, always, or reject")
      }
      return { name, output: await sessions.replyPermission(sessionId, permissionId, reply) }
    }
    case "focus_session": {
      const sessionId = sessions.resolve(String(args.session_id), ctx.currentSessionId)
      if (!focus) return { name, output: { focused: false, reason: "TUI focus is unavailable" } }
      const directory = sessions.directoryOf(sessionId)
      const focused = await focus(sessionId, directory)
      return { name, output: { focused, sessionId, directory } }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
  return parsed as Record<string, unknown>
}

/** Realtime sometimes emits truncated tool JSON. Close an open string/object so the call can still run. */
function repairJsonObject(raw: string): Record<string, unknown> | undefined {
  let repaired = raw.trim()
  if (!repaired.startsWith("{")) return
  if ((repaired.match(/"/g) ?? []).length % 2 === 1) repaired += '"'
  for (let extra = 0; extra <= 4; extra += 1) {
    try {
      const parsed = parseJsonObject(repaired + "}".repeat(extra))
      if (parsed) return parsed
    } catch {
      // try one more closing brace
    }
  }
}

export function parseToolArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw !== "string") return raw
  const text = raw.trim()
  if (!text) return {}
  try {
    return parseJsonObject(text) ?? {}
  } catch {
    const repaired = repairJsonObject(text)
    if (repaired) {
      voiceLog("tool args repaired", text.slice(0, 240))
      return repaired
    }
    voiceLog("tool args json", text.slice(0, 240))
    return {}
  }
}
