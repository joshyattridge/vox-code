export type SessionInfo = {
  id: string
  title: string
  directory?: string
}

export type SessionStatusMap = Record<string, { type: string; message?: string }>

export type TextPart = { type: "text"; text: string }

export type PermissionResponse = "once" | "always" | "reject"

/** OpenCode 1.18 TUI client is SDK v2: flat `{ sessionID, parts }` not `{ path: { id } }`. */
export type SessionClient = {
  session: {
    list: (parameters?: { directory?: string }) => Promise<{ data?: SessionInfo[]; error?: unknown }>
    create: (parameters?: {
      title?: string
      parentID?: string
      directory?: string
    }) => Promise<{ data?: SessionInfo; error?: unknown }>
    get: (parameters: { sessionID: string; directory?: string }) => Promise<{ data?: SessionInfo; error?: unknown }>
    status: (parameters?: { directory?: string }) => Promise<{ data?: SessionStatusMap; error?: unknown }>
    abort: (parameters: { sessionID: string; directory?: string }) => Promise<{ data?: boolean; error?: unknown }>
    promptAsync: (parameters: {
      sessionID: string
      directory?: string
      parts?: TextPart[]
    }) => Promise<{ data?: unknown; error?: unknown }>
    messages?: (parameters: {
      sessionID: string
      directory?: string
      limit?: number
    }) => Promise<{ data?: unknown; error?: unknown }>
    diff?: (parameters: { sessionID: string; directory?: string }) => Promise<{
      data?: Array<{ path?: string; file?: string; additions?: number; deletions?: number }>
      error?: unknown
    }>
  }
  permission: {
    respond: (parameters: {
      sessionID: string
      permissionID: string
      directory?: string
      response?: PermissionResponse
    }) => Promise<{ data?: boolean; error?: unknown }>
  }
}

export class ClientError extends Error {
  override cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "ClientError"
    this.cause = cause
  }
}

export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown }>,
  label: string,
  opts?: { allowEmpty?: boolean },
): Promise<T> {
  const result = await promise
  if (result.error) {
    const detail =
      typeof result.error === "object" && result.error && "message" in result.error
        ? String((result.error as { message: unknown }).message)
        : JSON.stringify(result.error)
    throw new ClientError(`${label} failed: ${detail}`, result.error)
  }
  if (result.data === undefined) {
    if (opts?.allowEmpty) return undefined as T
    throw new ClientError(`${label} returned no data`)
  }
  return result.data
}
