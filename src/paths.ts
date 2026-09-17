import { existsSync, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

const LINUX_ROOTS = ["/home/", "/root/", "/root", "/workspace/", "/workspace"]

export function sameDirectory(a?: string, b?: string) {
  if (!a || !b) return !a && !b
  return resolve(a) === resolve(b)
}

/** Map model-invented Linux/tmp paths onto this machine's home when needed. */
export function resolveWorkerDirectory(requested: string | undefined, current?: string): string | undefined {
  if (!requested?.trim()) return current
  const raw = requested.trim()
  if (raw === "~" || raw.toLowerCase() === "home") return homedir()
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))

  const linux =
    LINUX_ROOTS.some((root) => raw === root.replace(/\/$/, "") || raw.startsWith(root.endsWith("/") ? root : `${root}/`)) ||
    raw.startsWith("/home/")
  const tmp = raw.startsWith("/tmp/") || raw.startsWith("/private/tmp/")
  if (linux || (tmp && process.platform !== "linux")) {
    const name = basename(raw)
    if (!name || name === "home" || name === "root" || name === "workspace" || name === "tmp" || name === "private") {
      return homedir()
    }
    return join(homedir(), name)
  }
  return raw
}

export function ensureDirectory(dir: string): string {
  const tryMake = (path: string) => {
    if (existsSync(path)) {
      if (!statSync(path).isDirectory()) throw new Error(`Session directory is not a folder: ${path}`)
      return path
    }
    mkdirSync(path, { recursive: true })
    return path
  }
  try {
    return tryMake(dir)
  } catch (error) {
    const fallback = join(homedir(), basename(dir))
    if (fallback === dir) throw error
    return tryMake(fallback)
  }
}
