#!/usr/bin/env node
/**
 * One-command install for Vox Code.
 *
 *   npx github:joshyattridge/vox-code
 *
 * Copies the plugin into ~/.config/opencode/plugins/vox-code (outside
 * node_modules) so OpenCode's TUI actually renders the chip. A bare
 * `opencode plugin -g github:…` writes config but the chip stays invisible.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
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
    force: true,
    local: false,
    github: false,
    global: true,
    spec: process.env.VOICE_PLUGIN_SPEC?.trim() || "",
  }
  for (const raw of argv) {
    if (raw === "-h" || raw === "--help") args.help = true
    else if (raw === "--dry-run") args.dryRun = true
    else if (raw === "--force") args.force = true
    else if (raw === "--local") args.local = true
    else if (raw === "--github") args.github = true
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
  return `Install Vox Code (chip, /voice, background daemon).

Usage:
  npx github:joshyattridge/vox-code

This copies Vox Code into ~/.config/opencode/plugins/vox-code and registers
that folder. Do not use \`opencode plugin -g github:joshyattridge/vox-code\`
alone — OpenCode stores GitHub plugins under node_modules, and the TUI chip
does not render from there.

Options:
  --local      install from this checkout (absolute path, global config)
  --project    install into the current project's .opencode config
  --github     pass github:joshyattridge/vox-code to opencode plugin (no chip)
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

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) return resolve(process.env.OPENCODE_CONFIG_DIR.trim())
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return join(xdg || join(homedir(), ".config"), "opencode")
}

function stagedPluginDir() {
  return join(configDir(), "plugins", "vox-code")
}

function copyPlugin(from, to) {
  if (resolve(from) === resolve(to)) return
  if (!existsSync(join(from, "src/tui.tsx")) || !existsSync(join(from, "package.json"))) {
    throw new Error(`Vox Code sources missing in ${from}`)
  }
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const name of ["src", "scripts", "docs", "package.json", "package-lock.json", "README.md"]) {
    const src = join(from, name)
    if (!existsSync(src)) continue
    cpSync(src, join(to, name), { recursive: true })
  }
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

export { GIT_SPEC, MIN_OPENCODE, parseArgs, pluginDir, stagedPluginDir, versionAtLeast }

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(help())
    return 0
  }

  const opencode = args.dryRun ? "opencode" : findOpencode()
  if (!opencode) {
    throw new Error(`OpenCode is not installed (need ${MIN_OPENCODE}+).\nInstall it from https://opencode.ai then re-run.`)
  }
  if (!args.dryRun) {
    const versionResult = spawnSync(opencode, ["--version"], { encoding: "utf8" })
    const version = (versionResult.stdout || "").trim().split(/\s+/)[0]
    if (versionResult.status !== 0 || !/^v?\d+\.\d+\.\d+/.test(version)) {
      throw new Error("Could not determine the installed OpenCode version.")
    }
    if (!versionAtLeast(version, MIN_OPENCODE)) {
      throw new Error(`OpenCode ${version} is too old. Upgrade to ${MIN_OPENCODE}+ (opencode upgrade).`)
    }
  }

  let spec = args.spec
  if (args.local) spec = pluginDir
  else if (args.github && !spec) spec = GIT_SPEC
  else if (!spec) {
    const dest = stagedPluginDir()
    console.log(`Copying Vox Code to ${dest}`)
    if (!args.dryRun) copyPlugin(pluginDir, dest)
    // The detached Node daemon resolves ws from the staged folder; it cannot
    // rely on OpenCode's Bun plugin cache or this npx process's node_modules.
    const dependencies = run("npm", ["install", "--prefix", dest, "--omit=dev", "--omit=optional", "--ignore-scripts"], args.dryRun)
    if (dependencies.status !== 0) throw new Error(`Could not install Voice runtime dependencies: ${dependencies.stderr}`)
    spec = dest
  }

  if ((args.local || !args.github) && !args.spec && !existsSync(join(pluginDir, "src/tui.tsx"))) {
    throw new Error(`This package is missing src/tui.tsx at ${pluginDir}`)
  }

  const pluginArgs = ["plugin", spec]
  if (args.global) pluginArgs.push("-g")
  pluginArgs.push("-f")

  console.log(`Installing ${spec} ${args.global ? "globally" : "into this project"}…`)
  const result = run(opencode, pluginArgs, args.dryRun)
  if (result.stdout.trim()) process.stdout.write(result.stdout)
  if (result.stderr.trim()) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `opencode plugin failed (${result.status}). Add this spec yourself if you need to:\n` +
        `  opencode.json  plugin: ["${spec}"]\n` +
        `  tui.json       plugin: ["${spec}/src/tui.tsx"]`,
    )
  }

  if (!args.dryRun) {
    console.log("")
    console.log("Installed. Fully quit OpenCode and start it again.")
    console.log("  ○ voice appears on the right of the prompt")
    console.log("  /voice-key saves a Voice-only OpenAI platform API key")
    console.log("  /voice or Ctrl+Shift+V starts talking")
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
