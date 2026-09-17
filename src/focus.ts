import { voiceLog } from "./log.ts"

export type TuiFocusApi = {
  route: {
    navigate: (name: string, params?: Record<string, unknown>) => void
    current: { name: string; params?: Record<string, unknown> }
  }
  client: {
    tui: {
      selectSession: (params: {
        sessionID: string
        directory?: string
      }) => Promise<{ error?: unknown } | undefined>
      publish?: (params: {
        body: { type: "tui.session.select"; properties: { sessionID: string } }
      }) => Promise<{ error?: unknown } | undefined>
    }
  }
  ui?: {
    toast: (input: {
      title?: string
      message: string
      variant?: "info" | "success" | "warning" | "error"
      duration?: number
    }) => void
  }
}

function errorText(error: unknown) {
  if (typeof error === "object" && error && "message" in error) return String((error as { message: unknown }).message)
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function sessionRouteFocused(
  route: { name: string; params?: Record<string, unknown> },
  sessionId: string,
) {
  return route.name === "session" && route.params?.sessionID === sessionId
}

export async function focusTuiSession(
  api: TuiFocusApi,
  sessionId: string,
  directory?: string,
  currentDirectory?: string,
): Promise<boolean> {
  voiceLog("focus session", { sessionId, directory, current: currentDirectory })

  let navigated = false
  try {
    api.route.navigate("session", { sessionID: sessionId })
    navigated = true
    voiceLog("navigated session route", { sessionId, route: api.route.current })
  } catch (error) {
    voiceLog("session navigate failed", errorText(error))
  }

  const trySelect = async (dir?: string) => {
    const result = await api.client.tui.selectSession({
      sessionID: sessionId,
      ...(dir ? { directory: dir } : {}),
    })
    if (result?.error) throw new Error(errorText(result.error))
  }

  let selected = false
  try {
    // Address the visible TUI. `directory` on this RPC is the OpenCode instance,
    // not "open this other folder" — sending the worker path talks to a TUI
    // that is not on screen.
    await trySelect(currentDirectory)
    selected = true
  } catch (error) {
    voiceLog("selectSession current failed", errorText(error))
    if (directory && directory !== currentDirectory) {
      try {
        await trySelect(directory)
        selected = true
      } catch (retryError) {
        voiceLog("selectSession target failed", errorText(retryError))
      }
    }
  }

  try {
    await api.client.tui.publish?.({
      body: { type: "tui.session.select", properties: { sessionID: sessionId } },
    })
  } catch (error) {
    voiceLog("publish session.select failed", errorText(error))
  }

  const focused = sessionRouteFocused(api.route.current, sessionId) || navigated || selected
  voiceLog("focus result", {
    sessionId,
    focused,
    navigated,
    selected,
    route: api.route.current,
  })
  if (sessionRouteFocused(api.route.current, sessionId) || selected || navigated) {
    api.ui?.toast?.({
      title: "Vox Code",
      message: "Opened the worker session.",
      variant: "success",
      duration: 2500,
    })
  } else {
    api.ui?.toast?.({
      title: "Vox Code",
      message: "Could not switch the TUI to that session.",
      variant: "warning",
      duration: 4000,
    })
  }
  return focused
}
