import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const install = join(repo, "scripts/install.mjs")

function readPkg(dir: string) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string
    bin?: Record<string, string>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    exports: Record<string, string | { import?: string; config?: { voice?: string; model?: string } }>
  }
}

function exportImport(value: string | { import?: string }) {
  return typeof value === "string" ? value : value.import
}

test("GitHub / npx package is named vox-code and exposes server + TUI entrypoints", () => {
  const pkg = readPkg(repo)
  assert.equal(pkg.name, "vox-code")
  assert.equal(pkg.bin?.["vox-code"], "./scripts/install.mjs")
  assert.equal(pkg.dependencies?.["@opencode-ai/plugin"], undefined)
  assert.ok(pkg.peerDependencies?.["@opencode-ai/plugin"])
  const server = exportImport(pkg.exports["./server"])
  const tui = exportImport(pkg.exports["./tui"])
  assert.ok(server?.endsWith("src/index.ts"), server)
  assert.ok(tui?.endsWith("src/tui.tsx"), tui)
  assert.equal(existsSync(join(repo, server!)), true)
  assert.equal(existsSync(join(repo, tui!)), true)
  const tuiConfig = typeof pkg.exports["./tui"] === "object" ? pkg.exports["./tui"].config : undefined
  assert.equal(tuiConfig?.voice, "marin")
})

test("installer prints one-command usage", () => {
  const result = spawnSync(process.execPath, [install, "--help"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Install Vox Code/)
  assert.match(result.stdout, /npx github:joshyattridge\/vox-code/)
  assert.match(result.stdout, /node_modules/)
})

test("installer dry-run uses this checkout with --local", () => {
  const result = spawnSync(process.execPath, [install, "--local", "--dry-run"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /plugin/)
  assert.match(result.stdout, /-g/)
  assert.match(result.stdout, /vox-code/)
})

test("installer dry-run stages a file plugin outside node_modules", () => {
  const result = spawnSync(process.execPath, [install, "--dry-run"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /plugins\/vox-code/)
  assert.doesNotMatch(result.stdout, /github:joshyattridge\/vox-code/)
})
