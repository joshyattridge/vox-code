# Vox Code

Talk to OpenCode. It talks back. Worker sessions write the code.

**Vox Code** is an OpenCode plugin with a background voice daemon. There is no browser tab and no localhost webpage. OpenAI Realtime / GPT-Live run over a WebSocket in a detached process so OpenCode session and project switches cannot mute the speakers or tear down the mic. The TUI shows a chip next to the prompt:

- `○ voice` off
- `● VOICE` connected
- `● error`

The voice model is a **supervisor only**. It never edits the repo. It creates and prompts normal OpenCode sessions (Claude, GPT, or whatever you already configured).

## Requirements

- OpenCode 1.18.29+ (`opencode --version`)
- Node.js 22.6+ on PATH (the daemon uses native TypeScript stripping), or Bun for the daemon; development tests use Node.js 22.6+
- An OpenAI platform API key with Realtime access
- A microphone on the **same machine** as the OpenCode TUI
- Audio tools: `sox` (`rec` + `play`) **or** ALSA (`arecord` + `aplay`)

```bash
# macOS
brew install sox

# Debian/Ubuntu
sudo apt install sox alsa-utils
```

SSH into a remote OpenCode server uses **that** machine's mic. Run the TUI locally.

## Install

One command:

```bash
npx github:joshyattridge/vox-code
```

That copies Vox Code into `~/.config/opencode/plugins/vox-code` (outside `node_modules`) and registers the chip. Fully quit OpenCode and start it again. You should get a Voice toast, `○ voice` on the **right** of the prompt, and `/voice` in the slash list.

The installer also installs the staged daemon's runtime dependencies. `--dry-run` prints the planned commands without changing files or requiring an installed OpenCode binary. `--project` registers the staged plugin for the current project; `--local` registers this checkout directly.

Do **not** use `opencode plugin -g github:joshyattridge/vox-code` by itself. OpenCode will say “Installed”, but GitHub/npm TUI plugins load from `node_modules` and the chip never appears.

Vox Code keeps its OpenAI key separate from OpenCode's model-provider login. Run `/voice-key` in the TUI to add, replace, inspect, or remove an OpenAI platform API key. Entry is masked and the key is validated before storage. Voice uses macOS Keychain or Linux Secret Service when available, with `~/.local/share/opencode/vox-code/credentials.json` (`0600`) as a fallback. It never writes to OpenCode's `auth.json`.

ChatGPT Plus and ChatGPT/Codex OAuth do not include Realtime API access. The key needs OpenAI Platform billing enabled.

From this checkout (already wired in `opencode.json` **and** `tui.json`):

```bash
npm install
opencode
```

To install this checkout globally:

```bash
node scripts/install.mjs --local
```

## Use

| Action | How |
|---|---|
| Toggle | Click `○ voice`, `Ctrl+Shift+V`, `ctrl+p` → Voice: toggle, or `/voice` |
| Choose model | `ctrl+p` → Voice: model, or `/voice-model` (`gpt-live-1` or Realtime) |
| Choose speaker | `ctrl+p` → Voice: speaker, or `/voice-speaker` (plays a sample, then applies) |
| Set API key | `ctrl+p` → Voice: API key, or `/voice-key` |
| Edit speaking prompt | `ctrl+p` → Voice: prompt, or `/voice-prompt` |
| Start / stop | `/voice-on` `/voice-off` |
| Status toast | `/voice-status` |
| From a coding session | ask the agent to run `voice_status` |

Say things like:

- “Create a session titled auth refactor and have it extract the login handler.”
- “Spin up a second session to write tests while that one keeps going.”
- “What are my workers doing?”
- “Abort the tests session.”

You should hear a short reply. Worker sessions appear in OpenCode as usual. Realtime waits for you to speak; startup alone does not request a greeting.

### Conversation and audio behavior

- **Realtime:** the microphone stream is withheld during assistant playback and for a 300 ms echo hold afterward. Let the reply finish before speaking. This avoids speaker feedback with native audio tools, which do not provide acoustic echo cancellation.
- **GPT-Live:** input remains open during output for full-duplex conversation. Headphones help prevent speaker audio from feeding back into the microphone. Live has no authoritative audio-done event; a short packet-gap heuristic only updates playback state.
- Worker updates received during a Realtime response are queued for a follow-up. Parallel tool results are returned before requesting one continuation. Duplicate tool-call events are ignored within a connection.
- Playback preserves PCM order under backpressure. SoX reads the raw stream until EOF (`--ignore-length`), including on macOS where Node pipes can otherwise appear to contain only the first audio chunk.
- A failed microphone/speaker process is reported and follows the reconnect policy. `/voice-off` cancels pending playback and prevents old events from turning the chip back on.

## Config

Put active voice options on the plugin entry in **`tui.json`**. The TUI passes these to the daemon. `opencode.json` loads the server-side `voice_status` tool; its options provide defaults for status before a daemon snapshot exists. Model, speaker, and prompt choices made in the TUI are saved and override configured defaults.

For this checkout, a customized `tui.json` entry looks like:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["./src/tui.tsx", {
    "model": "gpt-realtime",
    "voice": "marin",
    "autoReconnect": true,
    "inactivityTimeoutMinutes": 10
  }]]
}
```

Keep the installer-generated plugin path when editing a global install. Quit and restart OpenCode after editing configuration. Options and environment defaults:

| Option | Env | Default |
|---|---|---|
| `model` | `OPENAI_REALTIME_MODEL` | `gpt-realtime` (or pick `gpt-live-1` with `/voice-model`) |
| `backendModel` | `OPENAI_LIVE_BACKEND_MODEL` | `gpt-5.6-luna` (used only with GPT-Live) |
| `voice` | `OPENAI_REALTIME_VOICE` | `marin` (pick others with `/voice-speaker`; a sample plays when you select one) |
| `instructions` | | spoken style added on top of the supervisor prompt. Edit with `/voice-prompt` |
| `keybind` | | `ctrl+shift+v` |
| `apiKey` | | legacy config fallback; `/voice-key` stores a separate preferred key |
| `autoReconnect` | | `true`; retry transient disconnects with exponential backoff |
| `inactivityTimeoutMinutes` | | `10`; `0` disables automatic inactivity stop |
| `costWarningMinutes` | | `30`; `0` disables the billing warning |
| `maxSessionDurationMinutes` | | `60`; `0` disables the session limit |
| `autoStopOnOpenCodeExit` | | `true`; stop after no TUI is connected for 15 seconds |

Realtime and GPT-Live audio is billed by OpenAI. `gpt-live-1` is **$0.05/min** for the voice layer; the delegated backend model is billed separately. The mic is live whenever the chip is `● VOICE`.

Transient network failures show `◌ reconnecting` and retry after 1, 2, 4, 8, 16, then at most 30 seconds, with jitter. `/voice-status` reports active duration, inactivity, and retry state. Sleep/wake and network changes preserve the requested-on state unless an inactivity or maximum-duration limit expires.

Reconnecting creates a fresh provider conversation; previous spoken conversation history is not replayed. OpenCode workers remain independent and are not recreated. Authentication/configuration errors stop automatic retries. A successful `/voice-key` validation checks authentication, while access to the chosen voice model is checked when connecting.

The OpenCode model picker (the one that switches Qwen / Claude / GPT) is for **coding sessions**. Vox Code uses `/voice-model`. Pick **gpt-live-1** for the new full-duplex Live model, or a `gpt-realtime*` id for the older Realtime API.

`/voice-speaker` lists OpenAI Realtime speakers (`marin`, `cedar`, `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`). Each row includes a sample line. Selecting one plays that sample through your speakers, then keeps the voice. Marin and Cedar are the ones OpenAI recommends.

`/voice-prompt` edits the **spoken style**. GPT-Live uses that as the voice-layer prompt and a separate backend prompt for tool calls. Realtime is one model, so a custom style is prepended to the supervisor/tool instructions instead of replacing them. Reset restores the default.

## How it is wired

```
Mic/speakers (sox or ffplay)
        ↕ PCM16 24kHz
Vox Code daemon (background process: WebSocket + audio)
        ↕ unix socket ~/.local/share/opencode/vox-code/vox.sock
TUI chip / commands  (disconnects on session switch; does not stop Vox Code)
        ↕ HTTP
OpenCode worker sessions
```

Switching OpenCode sessions or projects unloads the TUI plugin. That only disconnects the chip for a moment; the daemon keeps Vox Code up so it can reconnect. Quitting OpenCode entirely stops it after a few seconds with no TUI. `/voice-off` stops it immediately.

Tools the voice model can call: `current_context`, `list_sessions`, `create_session`, `prompt_session` (non-blocking), `abort_session`, `session_status`, `reply_permission`, `focus_session`.

See [architecture and tool behavior](docs/architecture.md) for the transport lifecycle and each tool's contract.

`current_context` gives the voice model a pull-only, bounded snapshot of the focused TUI session: route, project/worktree, selected model, up to six recent text messages, and up to twenty changed-file summaries. It does not expose tool output, patches, file contents, the unsent prompt, cursor/scroll position, or terminal buffers. Unsupported visible-panel details are reported as unavailable rather than inferred.

Parallel workers on the **same checkout** can overwrite each other. Ask for a separate directory or git worktree when you spawn a second editor.

## Tests

```bash
npm run test:all
```

This runs unit/component tests, local end-to-end scenarios over actual Unix sockets, WebSockets and HTTP, and TypeScript checking. The local E2E suite uses controlled OpenAI/OpenCode endpoints and in-memory audio. It exercises both voice backends, worker tools, PCM round trips, session switching, disconnects, recovery, and stop. Test data is isolated from your installed daemon. CI is configured for macOS/Linux with Node 22/24.

Optional real API smoke test (connects to Realtime and verifies non-silent PCM output):

```bash
OPENAI_REALTIME_SMOKE=1 OPENAI_API_KEY=sk-... npm run test:realtime-smoke
OPENAI_LIVE_SMOKE=1 OPENAI_API_KEY=sk-... npm run test:live-smoke
```

These optional checks use billable API calls and verify actual non-silent output without opening your microphone or speakers. See [testing and the manual acceptance scenarios](docs/testing.md) for coverage and hardware/TUI verification.

## Troubleshooting

| Symptom | Check |
|---|---|
| Reply stops after its first syllable | Update this checkout/install and fully restart OpenCode so the daemon picks up the SoX streaming fix. |
| No voice chip or slash commands | Confirm the TUI plugin is registered in `tui.json`, then restart OpenCode. |
| `◌ reconnecting` | Run `/voice-status`; check the network and the reported microphone/speaker or API error. |
| Authentication/model error | Use `/voice-key` for an OpenAI Platform key with billing and access to the selected model. |
| Voice hears itself | Use headphones with GPT-Live; Realtime automatically holds microphone transmission during replies. |
| No microphone audio on macOS | Allow microphone access for the terminal/runtime in System Settings, and check `rec` is installed. |

State, the Unix socket, PID file, and diagnostics live under `${XDG_DATA_HOME:-~/.local/share}/opencode/vox-code/` (`state.json`, `vox.sock`, `vox.pid`, `vox.log`). State snapshots are atomic, private (`0600`), and include the latest transcript window. Credentials use the OS keychain or the private fallback file described above. `/voice-off` releases audio immediately; a TUI disconnect alone allows a 15-second reconnection window.

## Limits

- No browser/WebRTC path
- No wake word
- Permissions are not auto-approved; Vox Code will ask you
- Headless `opencode serve` without a TUI has no chip; the server plugin still exposes `voice_status`
