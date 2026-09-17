# OpenCode Voice Supervisor

Talk to OpenCode. It talks back. Worker sessions write the code.

This is an **OpenCode plugin** with a **background voice daemon**. There is no browser tab and no localhost webpage. OpenAI Realtime / GPT-Live run over a WebSocket in a detached process so OpenCode session and project switches cannot mute the speakers or tear down the mic. The TUI shows a chip next to the prompt:

- `○ voice` off
- `● VOICE` connected
- `● listening` / `● speaking` / `● muted` / `● error`

The realtime model is a **supervisor only**. It never edits the repo. It creates and prompts normal OpenCode sessions (Claude, GPT, or whatever you already configured).

## Requirements

- OpenCode 1.18.29+ (`opencode --version`)
- An OpenAI API key with Realtime access
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

From this repo (already wired in `opencode.json` **and** `tui.json`):

```bash
cd opencode-voice-supervisor
npm install
cd ..
opencode
```

OpenCode 1.18 loads TUI plugins only from `tui.json` / `.opencode/tui.json`. `opencode.json` loads the server `voice_status` tool, not the chip. After `git pull`, fully quit OpenCode and restart it from the repo root. You should get a “Voice” toast, `○ voice` on the right of the prompt, and `/voice` in the slash list next to `/review`.

Voice uses the **OpenAI key already saved in OpenCode** (`opencode auth login` / `/connect`, stored in `~/.local/share/opencode/auth.json`). You do not need to `export OPENAI_API_KEY` again if OpenCode can already talk to OpenAI.

If OpenCode only has a ChatGPT/Codex OAuth login, Realtime still needs a platform API key: `opencode auth login` → OpenAI → API key.

Or add the plugin to any project. Server (tools) goes in `opencode.json`. Chip + `/voice` go in `tui.json` (or `.opencode/tui.json`):

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./opencode-voice-supervisor", { "voice": "marin", "model": "gpt-realtime" }]
  ]
}
```

```jsonc
// tui.json  (required for the chip — OpenCode does not auto-load TUI from opencode.json)
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["./opencode-voice-supervisor/src/tui.tsx", { "voice": "marin", "model": "gpt-realtime" }]
  ]
}
```

Absolute paths work too. The package exports `./server` and `./tui`; a TUI file plugin must not export `server`.

## Use

| Action | How |
|---|---|
| Toggle voice | Click `○ voice`, `Ctrl+Shift+V`, `ctrl+p` → Voice: toggle, or `/voice` |
| Choose voice model | `ctrl+p` → Voice: model, or `/voice-model` (`gpt-live-1` or Realtime) |
| Start / stop | `/voice-on` `/voice-off` |
| Mute mic | `/voice-mute` `/voice-unmute` |
| Status toast | `/voice-status` |
| Status panel | `/voice-panel` |
| From a coding session | ask the agent to run `voice_status` |

Say things like:

- “Create a session titled auth refactor and have it extract the login handler.”
- “Spin up a second session to write tests while that one keeps going.”
- “What are my workers doing?”
- “Abort the tests session.”

You should hear a short reply. Worker sessions appear in OpenCode as usual.

## Config

Plugin options in `opencode.json`, or env vars:

| Option | Env | Default |
|---|---|---|
| `model` | `OPENAI_REALTIME_MODEL` | `gpt-realtime` (or pick `gpt-live-1` with `/voice-model`) |
| `backendModel` | `OPENAI_LIVE_BACKEND_MODEL` | `gpt-5.6-luna` (used only with GPT-Live) |
| `voice` | `OPENAI_REALTIME_VOICE` | `marin` |
| `keybind` | | `ctrl+shift+v` |
| `apiKey` | | optional override; otherwise OpenCode auth / `OPENAI_API_KEY` |

Realtime and GPT-Live audio is billed by OpenAI. `gpt-live-1` is **$0.05/min** for the voice layer; the delegated backend model is billed separately. The mic is live whenever the chip is not `○ voice` or `● muted`.

The OpenCode model picker (the one that switches Qwen / Claude / GPT) is for **coding sessions**. Voice uses `/voice-model`. Pick **gpt-live-1** for the new full-duplex Live model, or a `gpt-realtime*` id for the older Realtime API.

## How it is wired

```
Mic/speakers (sox or ffplay)
        ↕ PCM16 24kHz
Voice daemon (background process: WebSocket + audio)
        ↕ unix socket ~/.local/share/opencode/voice-supervisor/voice.sock
TUI chip / commands  (disconnects on session switch; does not stop voice)
        ↕ HTTP
OpenCode worker sessions
```

Switching OpenCode sessions or projects unloads the TUI plugin. That only disconnects the chip. `/voice-off` is what actually stops the voice model. With the plugin installed globally, the chip comes back in the new folder.

Tools the voice model can call: `list_sessions`, `create_session`, `prompt_session` (non-blocking), `abort_session`, `session_status`, `reply_permission`, `focus_session`.

Parallel workers on the **same checkout** can overwrite each other. Ask for a separate directory or git worktree when you spawn a second editor.

## Tests

```bash
cd opencode-voice-supervisor
npm test
```

Manual: `/voice-on` → hear a greeting (if Realtime + speakers work) → “create a session titled ping and ask it to list files” → `/voice-status` shows an owned session.

## Limits

- No browser/WebRTC path
- No wake word
- Permissions are not auto-approved; the supervisor will ask you
- Headless `opencode serve` without a TUI has no chip; the server plugin still exposes `voice_status`
