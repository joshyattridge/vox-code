#!/usr/bin/env node
/**
 * One-command install for Vox Code.
 *
 *   npx github:joshyattridge/vox-code
 *   opencode plugin -g github:joshyattridge/vox-code
 *
 * OpenCode writes both opencode.json (server) and tui.json (chip / /vox).
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const GIT_SPEC = "github:joshyattridge/vox-code"
const MIN_OPENCODE = "1.18.29"
const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, "..")

function parseArgs(argv) {
  const args = {
    help: false,
    dryRun: false,
    force: false,
    local: false,
    global: true,
    spec: process.env.VOX_PLUGIN_SPEC?.trim() || GIT_SPEC,
  }
  for (const raw of argv) {
    if (raw === "-h" || raw === "--help") args.help = true
    else if (raw === "--dry-run") args.dryRun = true
    else if (raw === "--force") args.force = true
    else if (raw === "--local") args.local = true
    else if (raw === "--global") args.global = true
    else if (raw === "--project") {
      args.local = false
      args.global = false
    } else if (raw.startsWith("--spec=")) args.spec = raw.slice("--spec=".length).trim()
    else {
      throw new Error(`Unknown option: ${raw}\nUse --help for usage.`)
    }
  }
  return args
}

function help() {
  return `Install Vox Code (chip, /vox, background daemon).

Usage:
  npx github:joshyattridge/vox-code
  opencode plugin -g github:joshyattridge/vox-code

Options:
  --local      install from this checkout (absolute path, global config)
  --project    install into the current project's .opencode config
  --force      replace an existing plugin entry
  --spec=NAME  npm/git spec to pass to opencode plugin
  --dry-run    print the command without running it
  -h, --help   show this help

Needs OpenCode ${MIN_OPENCODE}+, an OpenAI API key, and sox (rec + play) or ALSA.
`
}

function versionAtLeast(have, need) {
  const parse = (value) =>
    value
      .replace(/^v/i, "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(have)
  const b = parse(need)
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left > right) return true
    if (left < right) return false
  }
  return true
}

function commandExists(bin) {
  const finder = process.platform === "win32" ? "where" : "which"
  const result = spawnSync(finder, [bin], { encoding: "utf8", stdio: "ignore" })
  if (result.status === 0) return true
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".opencode/bin")]
  return extras.some((dir) => existsSync(join(dir, bin)))
}

function findOpencode() {
  const fromPath = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], {
    encoding: "utf8",
  })
  const hit = fromPath.stdout?.trim().split(/\r?\n/).find(Boolean)
  if (hit && existsSync(hit)) return hit
  const fallback = join(homedir(), ".opencode/bin/opencode")
  if (existsSync(fallback)) return fallback
}

function run(command, argv, dryRun) {
  const printable = [command, ...argv].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")
  if (dryRun) {
    console.log(printable)
    return { status: 0, stdout: "", stderr: "" }
  }
  const result = spawnSync(command, argv, { encoding: "utf8", stdio: "pipe" })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  }
}

function audioHint() {
  const rec = commandExists("rec") || commandExists("arecord")
  const play = commandExists("play") || commandExists("aplay")
  if (rec && play) return
  console.log("")
  console.log("Audio tools not found. Install sox so the daemon can use the mic and speakers:")
  if (process.platform === "darwin") console.log("  brew install sox")
  else console.log("  sudo apt install sox alsa-utils")
}

export { GIT_SPEC, MIN_OPENCODE, parseArgs, pluginDir, versionAtLeast }

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(help())
    return 0
  }

  const spec = args.local ? pluginDir : args.spec
  if (args.local && !existsSync(join(pluginDir, "src/tui.tsx"))) {
    throw new Error(`This checkout is missing src/tui.tsx at ${pluginDir}`)
  }

  const opencode = findOpencode()
  if (!opencode) {
    throw new Error(
      `OpenCode is not installed (need ${MIN_OPENCODE}+).\nInstall it from https://opencode.ai then re-run.`,
    )
  }

  const versionResult = spawnSync(opencode, ["--version"], { encoding: "utf8" })
  const version = (versionResult.stdout || versionResult.stderr || "").trim().split(/\s+/)[0]
  if (version && !versionAtLeast(version, MIN_OPENCODE)) {
    throw new Error(`OpenCode ${version} is too old. Upgrade to ${MIN_OPENCODE}+ (opencode upgrade).`)
  }

  const pluginArgs = ["plugin", spec]
  if (args.global) pluginArgs.push("-g")
  if (args.force) pluginArgs.push("-f")

  console.log(`Installing ${spec} ${args.global ? "globally" : "into this project"}…`)
  const result = run(opencode, pluginArgs, args.dryRun)
  if (result.stdout.trim()) process.stdout.write(result.stdout)
  if (result.stderr.trim()) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `opencode plugin failed (${result.status}). Add this spec yourself if you need to:\n` +
        `  opencode.json  plugin: ["${spec}"]\n` +
        `  tui.json       plugin: ["${spec}"]`,
    )
  }

  if (!args.dryRun) {
    console.log("")
    console.log("Installed. Fully quit OpenCode and start it again.")
    console.log("  ○ vox appears in the prompt")
    console.log("  /vox or Ctrl+Shift+V starts talking")
    console.log("  OpenAI key: opencode auth login  (platform API key, not ChatGPT OAuth)")
    audioHint()
  }
  return 0
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
