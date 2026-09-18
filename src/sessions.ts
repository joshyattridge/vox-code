import { unwrap, type SessionClient, type SessionInfo } from "./client.ts"
import { ensureDirectory, resolveWorkerDirectory } from "./paths.ts"
import type { PermissionReply, SessionSnapshot } from "./types.ts"

export type SessionController = {
  list: () => Promise<SessionSnapshot[]>
  create: (input: { title?: string; directory?: string }) => Promise<SessionSnapshot>
  prompt: (sessionId: string, prompt: string) => Promise<{ accepted: true; sessionId: string }>
  abort: (sessionId: string) => Promise<{ aborted: boolean; sessionId: string }>
  status: (sessionId: string) => Promise<{
    sessionId: string
    title: string
    status: string
    owned: boolean
    complete?: boolean
    summary?: string
    lastMessage?: string
  }>
  replyPermission: (
    sessionId: string,
    permissionId: string,
    reply: PermissionReply,
  ) => Promise<{ ok: boolean }>
  markOwned: (sessionId: string) => void
  ownedIds: () => string[]
  directoryOf: (sessionId: string) => string | undefined
  resolve: (sessionId: string, currentId?: string) => string
}

function statusOf(map: Record<string, { type: string }> | undefined, id: string): string {
  return map ? map[id]?.type ?? "idle" : "unknown"
}

const LAST_MESSAGE_CHARS = 1500

export function lastAssistantText(raw: unknown): string | undefined {
  const items = messagesFrom(raw)
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const text = assistantTextFrom(items[i])
    if (text) return text.length > LAST_MESSAGE_CHARS ? `${text.slice(0, LAST_MESSAGE_CHARS)}…` : text
  }
}

function messagesFrom(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object" && "data" in raw) {
    const data = (raw as { data: unknown }).data
    if (Array.isArray(data)) return data
  }
  return []
}

function assistantTextFrom(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return
  const row = item as {
    type?: string
    text?: string
    content?: unknown
    info?: { role?: string }
    parts?: unknown
  }
  if (row.type === "assistant") {
    if (typeof row.text === "string" && row.text.trim()) return row.text.trim()
    if (Array.isArray(row.content)) {
      const text = row.content
        .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  }
  if (row.info?.role === "assistant" && Array.isArray(row.parts)) {
    const text = row.parts
      .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
}

export function createSessionController(
  client: SessionClient,
  directory?: string | (() => string | undefined),
): SessionController {
  const owned = new Set<string>()
  const dirs = new Map<string, string>()
  const defaultDirectory = () => (typeof directory === "function" ? directory() : directory)

  const scopeFor = (sessionId?: string) => {
    const dir = (sessionId ? dirs.get(sessionId) : undefined) ?? defaultDirectory()
    return dir ? { directory: dir } : {}
  }

  const listRaw = async (): Promise<SessionInfo[]> => {
    const dir = defaultDirectory()
    return unwrap(client.session.list(dir ? { directory: dir } : undefined), "list sessions")
  }

  return {
    markOwned(sessionId) {
      owned.add(sessionId)
    },
    ownedIds() {
      return [...owned]
    },
    directoryOf(sessionId) {
      return dirs.get(sessionId)
    },
    resolve(sessionId, currentId) {
      if (sessionId === "current") {
        if (!currentId) throw new Error("No current session is focused")
        return currentId
      }
      return sessionId
    },
    async list() {
      const [sessions, statuses] = await Promise.all([
        listRaw(),
        unwrap(client.session.status(defaultDirectory() ? { directory: defaultDirectory() } : undefined), "session status").catch(
          () => undefined,
        ),
      ])
      const rows = sessions.map((session) => ({
        id: session.id,
        title: session.title,
        directory: session.directory,
        status: statusOf(statuses, session.id),
        owned: owned.has(session.id),
      }))
      const seen = new Set(rows.map((row) => row.id))
      for (const id of owned) {
        if (seen.has(id)) continue
        try {
          const [info, workerStatuses] = await Promise.all([
            unwrap(client.session.get({ sessionID: id, ...scopeFor(id) }), "get session"),
            unwrap(client.session.status(scopeFor(id)), "session status").catch(() => undefined),
          ])
          if (info.directory) dirs.set(info.id, info.directory)
          rows.push({
            id: info.id,
            title: info.title,
            directory: info.directory,
            status: statusOf(workerStatuses, info.id),
            owned: true,
          })
        } catch {
          rows.push({
            id,
            title: id,
            directory: dirs.get(id),
            status: "unknown",
            owned: true,
          })
        }
      }
      return rows
    },
    async create(input) {
      const dir = resolveWorkerDirectory(input.directory, defaultDirectory())
      const createdDir = dir ? ensureDirectory(dir) : undefined
      const created = await unwrap(
        client.session.create({
          title: input.title,
          directory: createdDir,
        }),
        "create session",
      )
      owned.add(created.id)
      const resolvedDir = created.directory ?? createdDir
      if (resolvedDir) dirs.set(created.id, resolvedDir)
      return {
        id: created.id,
        title: created.title,
        directory: resolvedDir,
        status: "idle",
        owned: true,
      }
    },
    async prompt(sessionId, prompt) {
      await unwrap(
        client.session.promptAsync({
          sessionID: sessionId,
          ...scopeFor(sessionId),
          parts: [{ type: "text", text: prompt }],
        }),
        "prompt session",
        { allowEmpty: true },
      )
      owned.add(sessionId)
      return { accepted: true, sessionId }
    },
    async abort(sessionId) {
      const aborted = await unwrap(
        client.session.abort({ sessionID: sessionId, ...scopeFor(sessionId) }),
        "abort session",
      )
      return { aborted: Boolean(aborted), sessionId }
    },
    async status(sessionId) {
      const scoped = scopeFor(sessionId)
      const [info, statuses] = await Promise.all([
        unwrap(client.session.get({ sessionID: sessionId, ...scoped }), "get session"),
        unwrap(client.session.status(scoped.directory ? scoped : undefined), "session status").catch(
          () => undefined,
        ),
      ])
      let summary: string | undefined
      if (client.session.diff) {
        try {
          const diff = await unwrap(client.session.diff({ sessionID: sessionId, ...scoped }), "session diff")
          if (diff.length) {
            const files = diff.length
            const additions = diff.reduce((sum, row) => sum + (row.additions ?? 0), 0)
            const deletions = diff.reduce((sum, row) => sum + (row.deletions ?? 0), 0)
            summary = `${files} file${files === 1 ? "" : "s"} changed, +${additions} / -${deletions}`
          }
        } catch {
          summary = undefined
        }
      }
      if (info.directory) dirs.set(info.id, info.directory)
      const status = statusOf(statuses, info.id)
      let lastMessage: string | undefined
      if (client.session.messages) {
        try {
          const messages = await unwrap(
            client.session.messages({ sessionID: sessionId, ...scoped, limit: 40 }),
            "session messages",
          )
          lastMessage = lastAssistantText(messages)
        } catch {
          lastMessage = undefined
        }
      }
      const running = status === "busy" || status === "running" || status === "retry"
      return {
        sessionId: info.id,
        title: info.title,
        status,
        owned: owned.has(info.id),
        complete: status !== "unknown" && !running && Boolean(lastMessage),
        summary,
        lastMessage,
      }
    },
    async replyPermission(sessionId, permissionId, reply) {
      const ok = await unwrap(
        client.permission.respond({
          sessionID: sessionId,
          permissionID: permissionId,
          ...scopeFor(sessionId),
          response: reply,
        }),
        "reply permission",
      )
      return { ok: Boolean(ok) }
    },
  }
}
