import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

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
  const source = [
    readFileSync(join(root, "src/tui.tsx"), "utf8"),
    readFileSync(join(root, "src/focus.ts"), "utf8"),
  ].join("\n")
  assert.match(source, /keymap\.registerLayer/)
  assert.match(source, /slashName: "voice"/)
  assert.match(source, /command\?\.register/)
  assert.match(source, /slash: \{ name: "voice" \}/)
  assert.match(source, /namespace: "palette"/)
  assert.match(source, /LIVE_MODELS/)
  assert.match(source, /gpt-live-1/)
  assert.match(source, /REALTIME_VOICES/)
  assert.match(source, /voice-speaker/)
  assert.match(source, /voice-prompt/)
  assert.match(source, /voice-key/)
  assert.match(source, /setApiKey/)
  assert.match(source, /previewVoice/)
  assert.match(source, /setInstructions/)
  assert.doesNotMatch(source, /voice-mute/)
  assert.doesNotMatch(source, /voice-unmute/)
  assert.doesNotMatch(source, /voice-panel/)
  assert.doesNotMatch(source, /slashName: "vox/)
  assert.doesNotMatch(source, /slash: \{ name: "vox/)
  assert.match(source, /session_prompt_right/)
  assert.match(source, /home_prompt_right/)
  assert.match(source, /focusTuiSession/)
  assert.match(source, /navigated session route/)
  assert.match(source, /tui\.selectSession/)
  assert.match(source, /tui\.session\.select/)
  assert.match(source, /attachVoiceDaemon/)
  assert.match(source, /tui disconnect keep-alive/)
  assert.doesNotMatch(source, /skip focus other project/)
  assert.doesNotMatch(source, /rebindAudio/)
  assert.doesNotMatch(source, /createVoiceSupervisor/)
})

test("the complete TUI entrypoint compiles with OpenTUI's Solid transform", async () => {
  // Exercise the same transform shipped with our pinned OpenTUI version,
  // including the patched Babel dependency used by development tooling.
  const transformer = new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid"))
  const { transformSolidSource } = await import(transformer.href)
  const filename = join(root, "src/tui.tsx")
  const output = await transformSolidSource(readFileSync(filename, "utf8"), { filename })
  assert.match(output, /export default plugin/)
  assert.match(output, /createComponent/)
  assert.doesNotMatch(output, /<DialogSelect|<ApiKeyDialog|<Chip/)
})
