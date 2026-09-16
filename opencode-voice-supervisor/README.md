# OpenCode Voice Supervisor

Talk to OpenCode. It talks back. Worker sessions write the code.

This is an **in-process OpenCode plugin**. There is no browser tab and no localhost webpage. OpenAI Realtime runs over a WebSocket inside OpenCode. The TUI shows a chip next to the prompt:

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

From this repo (already wired in `opencode.json`):

```bash
cd opencode-voice-supervisor
npm install
cd ..
export OPENAI_API_KEY=sk-...
opencode
```

Or add the plugin to any project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./opencode-voice-supervisor", { "voice": "marin", "model": "gpt-realtime" }]
  ]
}
```

Absolute paths work too. OpenCode loads both the server entry (`.`) and the TUI entry (`./tui`).

## Use

| Action | How |
|---|---|
| Toggle voice | `/voice` or `Ctrl+Shift+V` or click the chip |
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
| `model` | `OPENAI_REALTIME_MODEL` | `gpt-realtime` |
| `voice` | `OPENAI_REALTIME_VOICE` | `marin` |
| `keybind` | | `ctrl+shift+v` |
| `apiKey` | `OPENAI_API_KEY` | required |

Realtime audio is billed by OpenAI. The mic is live whenever the chip is not `○ voice` or `● muted`.

## How it is wired

```
Mic/speakers (sox or arecord/aplay)
        ↕ PCM16 24kHz
TUI plugin  +  server plugin
        ↕ WebSocket
OpenAI Realtime (talk / listen / tools)
        ↕ create_session, prompt_session, ...
OpenCode worker sessions
```

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
