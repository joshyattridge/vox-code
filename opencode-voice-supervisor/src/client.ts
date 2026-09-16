export type SessionInfo = {
  id: string
  title: string
  directory?: string
}

export type SessionStatusMap = Record<string, { type: string; message?: string }>

export type TextPart = { type: "text"; text: string }

export type SessionClient = {
  session: {
    list: (options?: { query?: { directory?: string } }) => Promise<{ data?: SessionInfo[]; error?: unknown }>
    create: (options?: {
      body?: { title?: string; parentID?: string }
      query?: { directory?: string }
    }) => Promise<{ data?: SessionInfo; error?: unknown }>
    get: (options: { path: { id: string } }) => Promise<{ data?: SessionInfo; error?: unknown }>
    status: () => Promise<{ data?: SessionStatusMap; error?: unknown }>
    abort: (options: { path: { id: string } }) => Promise<{ data?: boolean; error?: unknown }>
    promptAsync: (options: {
      path: { id: string }
      body: { parts: TextPart[] }
    }) => Promise<{ data?: unknown; error?: unknown }>
    messages?: (options: { path: { id: string } }) => Promise<{ data?: unknown; error?: unknown }>
    diff?: (options: { path: { id: string } }) => Promise<{
      data?: Array<{ path?: string; file?: string; additions?: number; deletions?: number }>
      error?: unknown
    }>
  }
  postSessionIdPermissionsPermissionId: (options: {
    path: { id: string; permissionID: string }
    body: { response: "once" | "always" | "reject" }
  }) => Promise<{ data?: boolean; error?: unknown }>
}

export class ClientError extends Error {
  override cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "ClientError"
    this.cause = cause
  }
}

export async function unwrap<T>(promise: Promise<{ data?: T; error?: unknown }>, label: string): Promise<T> {
  const result = await promise
  if (result.error) {
    const detail =
      typeof result.error === "object" && result.error && "message" in result.error
        ? String((result.error as { message: unknown }).message)
        : JSON.stringify(result.error)
    throw new ClientError(`${label} failed: ${detail}`, result.error)
  }
  if (result.data === undefined) {
    throw new ClientError(`${label} returned no data`)
  }
  return result.data
}
