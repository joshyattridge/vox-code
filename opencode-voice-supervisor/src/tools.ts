import type { SessionController } from "./sessions.ts"

export type ToolContext = {
  currentSessionId?: string
  warnSharedCheckout?: boolean
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
      "Create a new worker OpenCode session. Use a separate directory/worktree when two sessions will edit files at once.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the session" },
        directory: {
          type: "string",
          description: "Absolute project directory or git worktree for this worker",
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
    description: "Get status and a short diff summary for a session.",
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
    description: "Focus a session tab in the OpenCode TUI if the user is looking at the TUI.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
] as const

export type FocusHandler = (sessionId: string) => boolean | Promise<boolean>

export async function executeTool(
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
      const created = await sessions.create({ title, directory })
      const warning =
        !directory && ctx.warnSharedCheckout
          ? "This worker shares the same checkout as other sessions. Parallel file edits may collide."
          : undefined
      return { name, output: { ...created, warning } }
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
      const focused = await focus(sessionId)
      return { name, output: { focused, sessionId } }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export function parseToolArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  }
  return raw
}
