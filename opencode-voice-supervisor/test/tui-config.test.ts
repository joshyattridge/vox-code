import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")

test("tui.json lists the TUI plugin so OpenCode shows the chip and /voice", () => {
  const configs = [
    join(root, "tui.json"),
    join(root, ".opencode/tui.json"),
  ]
  for (const path of configs) {
    const json = JSON.parse(readFileSync(path, "utf8")) as { plugin: unknown[] }
    const specs = json.plugin.map((entry) => (Array.isArray(entry) ? entry[0] : entry))
    assert.ok(
      specs.some((spec) => typeof spec === "string" && spec.endsWith("src/tui.tsx")),
      `${path} must list the TUI plugin file`,
    )
  }
})

test("tui plugin registers palette slash commands", () => {
  const source = readFileSync(join(root, "opencode-voice-supervisor/src/tui.tsx"), "utf8")
  assert.match(source, /keymap\.registerLayer/)
  assert.match(source, /slashName: "voice"/)
  assert.match(source, /namespace: "palette"/)
  assert.match(source, /session_prompt_right/)
  assert.match(source, /home_prompt_right/)
})
