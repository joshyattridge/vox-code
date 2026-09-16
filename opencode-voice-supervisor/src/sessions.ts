import { unwrap, type SessionClient, type SessionInfo } from "./client.ts"
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
    summary?: string
  }>
  replyPermission: (
    sessionId: string,
    permissionId: string,
    reply: PermissionReply,
  ) => Promise<{ ok: boolean }>
  markOwned: (sessionId: string) => void
  ownedIds: () => string[]
  resolve: (sessionId: string, currentId?: string) => string
}

function statusOf(map: Record<string, { type: string }> | undefined, id: string): string {
  return map?.[id]?.type ?? "unknown"
}

export function createSessionController(client: SessionClient, directory?: string): SessionController {
  const owned = new Set<string>()

  const listRaw = async (): Promise<SessionInfo[]> => {
    return unwrap(client.session.list(directory ? { query: { directory } } : undefined), "list sessions")
  }

  return {
    markOwned(sessionId) {
      owned.add(sessionId)
    },
    ownedIds() {
      return [...owned]
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
        unwrap(client.session.status(), "session status").catch(() => ({}) as Record<string, { type: string }>),
      ])
      return sessions.map((session) => ({
        id: session.id,
        title: session.title,
        directory: session.directory,
        status: statusOf(statuses, session.id),
        owned: owned.has(session.id),
      }))
    },
    async create(input) {
      const created = await unwrap(
        client.session.create({
          body: input.title ? { title: input.title } : undefined,
          query: input.directory ? { directory: input.directory } : directory ? { directory } : undefined,
        }),
        "create session",
      )
      owned.add(created.id)
      return {
        id: created.id,
        title: created.title,
        directory: created.directory ?? input.directory,
        status: "idle",
        owned: true,
      }
    },
    async prompt(sessionId, prompt) {
      await unwrap(
        client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: prompt }] },
        }),
        "prompt session",
      )
      owned.add(sessionId)
      return { accepted: true, sessionId }
    },
    async abort(sessionId) {
      const aborted = await unwrap(client.session.abort({ path: { id: sessionId } }), "abort session")
      return { aborted: Boolean(aborted), sessionId }
    },
    async status(sessionId) {
      const [info, statuses] = await Promise.all([
        unwrap(client.session.get({ path: { id: sessionId } }), "get session"),
        unwrap(client.session.status(), "session status").catch(() => ({}) as Record<string, { type: string }>),
      ])
      let summary: string | undefined
      if (client.session.diff) {
        try {
          const diff = await unwrap(client.session.diff({ path: { id: sessionId } }), "session diff")
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
      return {
        sessionId: info.id,
        title: info.title,
        status: statusOf(statuses, info.id),
        owned: owned.has(info.id),
        summary,
      }
    },
    async replyPermission(sessionId, permissionId, reply) {
      const ok = await unwrap(
        client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          body: { response: reply },
        }),
        "reply permission",
      )
      return { ok: Boolean(ok) }
    },
  }
}
