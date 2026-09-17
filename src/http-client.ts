import { voiceLog } from "./log.ts"
import type { PermissionResponse, SessionClient, SessionInfo, SessionStatusMap, TextPart } from "./client.ts"
import type { ClientConfig } from "./protocol.ts"

function joinUrl(base: string, path: string, directory?: string) {
  const url = `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`
  if (!directory) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}directory=${encodeURIComponent(directory)}`
}

export function createHttpSessionClient(config: ClientConfig, directory?: string): SessionClient {
  const baseUrl = config.baseUrl
  if (!baseUrl) {
    const missing = async () => ({ error: { message: "Vox Code daemon has no OpenCode server URL" } })
    return {
      session: {
        list: missing,
        create: missing,
        get: missing,
        status: missing,
        abort: missing,
        promptAsync: missing,
        messages: missing,
        diff: missing,
      },
      permission: { respond: missing },
    }
  }

  const request = async <T>(
    method: string,
    path: string,
    options?: { body?: unknown; directory?: string },
  ): Promise<{ data?: T; error?: unknown }> => {
    const dir = options?.directory ?? directory
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(config.headers ?? {}),
    }
    if (dir) headers["x-opencode-directory"] = encodeURIComponent(dir)
    if (options?.body !== undefined) headers["content-type"] = "application/json"
    try {
      const response = await fetch(joinUrl(baseUrl, path, dir), {
        method,
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      })
      if (response.status === 204) return {}
      const json = (await response.json().catch(() => undefined)) as T | { message?: string } | undefined
      if (!response.ok) {
        return { error: json && typeof json === "object" ? json : { message: `HTTP ${response.status}` } }
      }
      return { data: json as T }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      voiceLog("http error", { url: joinUrl(baseUrl, path, dir), method, message })
      return { error: { message } }
    }
  }

  return {
    session: {
      list: (parameters) => request<SessionInfo[]>("GET", "/session", { directory: parameters?.directory }),
      create: (parameters) =>
        request<SessionInfo>("POST", "/session", {
          directory: parameters?.directory,
          body: { title: parameters?.title, parentID: parameters?.parentID },
        }),
      get: (parameters) =>
        request<SessionInfo>("GET", `/session/${encodeURIComponent(parameters.sessionID)}`, {
          directory: parameters.directory,
        }),
      status: (parameters) =>
        request<SessionStatusMap>("GET", "/session/status", { directory: parameters?.directory }),
      abort: (parameters) =>
        request<boolean>("POST", `/session/${encodeURIComponent(parameters.sessionID)}/abort`, {
          directory: parameters.directory,
        }),
      promptAsync: (parameters) =>
        request<unknown>("POST", `/session/${encodeURIComponent(parameters.sessionID)}/prompt_async`, {
          directory: parameters.directory,
          body: { parts: parameters.parts as TextPart[] },
        }),
      messages: (parameters) => {
        const limit = parameters.limit ? `?limit=${encodeURIComponent(String(parameters.limit))}` : ""
        return request("GET", `/session/${encodeURIComponent(parameters.sessionID)}/message${limit}`, {
          directory: parameters.directory,
        })
      },
      diff: (parameters) =>
        request("GET", `/session/${encodeURIComponent(parameters.sessionID)}/diff`, {
          directory: parameters.directory,
        }),
    },
    permission: {
      respond: (parameters) =>
        request<boolean>(
          "POST",
          `/session/${encodeURIComponent(parameters.sessionID)}/permissions/${encodeURIComponent(parameters.permissionID)}`,
          {
            directory: parameters.directory,
            body: { response: parameters.response as PermissionResponse },
          },
        ),
    },
  }
}

export function createSessionClientProxy(initial: SessionClient) {
  let inner = initial
  const proxy: SessionClient & { replace: (next: SessionClient) => void } = {
    replace(next) {
      inner = next
    },
    session: {
      list: (parameters) => inner.session.list(parameters),
      create: (parameters) => inner.session.create(parameters),
      get: (parameters) => inner.session.get(parameters),
      status: (parameters) => inner.session.status(parameters),
      abort: (parameters) => inner.session.abort(parameters),
      promptAsync: (parameters) => inner.session.promptAsync(parameters),
      messages: (parameters) => inner.session.messages?.(parameters) ?? Promise.resolve({ data: [] }),
      diff: (parameters) => inner.session.diff?.(parameters) ?? Promise.resolve({ data: [] }),
    },
    permission: {
      respond: (parameters) => inner.permission.respond(parameters),
    },
  }
  return proxy
}

export async function dispatchSessionOp(
  client: SessionClient,
  op: string,
  params?: unknown,
): Promise<{ data?: unknown; error?: unknown }> {
  const args = (params ?? {}) as Record<string, unknown>
  switch (op) {
    case "session.list":
      return client.session.list(args as { directory?: string })
    case "session.create":
      return client.session.create(args as { title?: string; parentID?: string; directory?: string })
    case "session.get":
      return client.session.get(args as { sessionID: string; directory?: string })
    case "session.status":
      return client.session.status(args as { directory?: string })
    case "session.abort":
      return client.session.abort(args as { sessionID: string; directory?: string })
    case "session.promptAsync":
      return client.session.promptAsync(args as { sessionID: string; directory?: string; parts?: TextPart[] })
    case "session.messages":
      return (
        client.session.messages?.(args as { sessionID: string; directory?: string; limit?: number }) ?? { data: [] }
      )
    case "session.diff":
      return client.session.diff?.(args as { sessionID: string; directory?: string }) ?? { data: [] }
    case "permission.respond":
      return client.permission.respond(
        args as { sessionID: string; permissionID: string; directory?: string; response?: PermissionResponse },
      )
    default:
      return { error: { message: `Unknown session op ${op}` } }
  }
}

export function createRpcSessionClient(
  request: (op: string, params?: unknown) => Promise<{ data?: unknown; error?: unknown }>,
): SessionClient {
  return {
    session: {
      list: (parameters) => request("session.list", parameters) as Promise<{ data?: SessionInfo[]; error?: unknown }>,
      create: (parameters) => request("session.create", parameters) as Promise<{ data?: SessionInfo; error?: unknown }>,
      get: (parameters) => request("session.get", parameters) as Promise<{ data?: SessionInfo; error?: unknown }>,
      status: (parameters) =>
        request("session.status", parameters) as Promise<{ data?: SessionStatusMap; error?: unknown }>,
      abort: (parameters) => request("session.abort", parameters) as Promise<{ data?: boolean; error?: unknown }>,
      promptAsync: (parameters) => request("session.promptAsync", parameters),
      messages: (parameters) => request("session.messages", parameters),
      diff: (parameters) => request("session.diff", parameters) as ReturnType<NonNullable<SessionClient["session"]["diff"]>>,
    },
    permission: {
      respond: (parameters) =>
        request("permission.respond", parameters) as Promise<{ data?: boolean; error?: unknown }>,
    },
  }
}
