# Vox Code

Talk to OpenCode. It talks back. Worker sessions write the code.

**Vox Code** is an OpenCode plugin with a background voice daemon. There is no browser tab and no localhost webpage. OpenAI Realtime / GPT-Live run over a WebSocket in a detached process so OpenCode session and project switches cannot mute the speakers or tear down the mic. The TUI shows a chip next to the prompt:

- `○ vox` off
- `● VOX` connected
- `● error`

The voice model is a **supervisor only**. It never edits the repo. It creates and prompts normal OpenCode sessions (Claude, GPT, or whatever you already configured).

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

One command:

```bash
npx github:joshyattridge/vox-code
```

That copies Vox Code into `~/.config/opencode/plugins/vox-code` (outside `node_modules`) and registers the chip. Fully quit OpenCode and start it again. You should get a Vox Code toast, `○ vox` on the **right** of the prompt, and `/vox` in the slash list (`/voice` still works).

Do **not** use `opencode plugin -g github:joshyattridge/vox-code` by itself. OpenCode will say “Installed”, but GitHub/npm TUI plugins load from `node_modules` and the chip never appears.

Vox Code uses the **OpenAI key already saved in OpenCode** (`opencode auth login` / `/connect`, stored in `~/.local/share/opencode/auth.json`). You do not need to `export OPENAI_API_KEY` again if OpenCode can already talk to OpenAI.

If OpenCode only has a ChatGPT/Codex OAuth login, Realtime still needs a platform API key: `opencode auth login` → OpenAI → API key.

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
| Toggle | Click `○ vox`, `Ctrl+Shift+V`, `ctrl+p` → Vox: toggle, or `/vox` |
| Choose model | `ctrl+p` → Vox: model, or `/vox-model` (`gpt-live-1` or Realtime) |
| Choose speaker | `ctrl+p` → Vox: speaker, or `/vox-voice` (plays a sample, then applies) |
| Edit speaking prompt | `ctrl+p` → Vox: prompt, or `/vox-prompt` |
| Start / stop | `/vox-on` `/vox-off` |
| Status toast | `/vox-status` |
| From a coding session | ask the agent to run `vox_status` |

`/voice`, `/voice-model`, and the other `/voice-*` commands still work as aliases.

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
| `model` | `OPENAI_REALTIME_MODEL` | `gpt-realtime` (or pick `gpt-live-1` with `/vox-model`) |
| `backendModel` | `OPENAI_LIVE_BACKEND_MODEL` | `gpt-5.6-luna` (used only with GPT-Live) |
| `voice` | `OPENAI_REALTIME_VOICE` | `marin` (pick others with `/vox-voice`; a sample plays when you select one) |
| `instructions` | | spoken style added on top of the supervisor prompt. Edit with `/vox-prompt` |
| `keybind` | | `ctrl+shift+v` |
| `apiKey` | | optional override; otherwise OpenCode auth / `OPENAI_API_KEY` |

Realtime and GPT-Live audio is billed by OpenAI. `gpt-live-1` is **$0.05/min** for the voice layer; the delegated backend model is billed separately. The mic is live whenever the chip is `● VOX`.

The OpenCode model picker (the one that switches Qwen / Claude / GPT) is for **coding sessions**. Vox Code uses `/vox-model`. Pick **gpt-live-1** for the new full-duplex Live model, or a `gpt-realtime*` id for the older Realtime API.

`/vox-voice` lists OpenAI Realtime speakers (`marin`, `cedar`, `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`). Each row includes a sample line. Selecting one plays that sample through your speakers, then keeps the voice. Marin and Cedar are the ones OpenAI recommends.

`/vox-prompt` edits the **spoken style**. GPT-Live uses that as the voice-layer prompt and a separate backend prompt for tool calls. Realtime is one model, so a custom style is prepended to the supervisor/tool instructions instead of replacing them. Reset restores the default.

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

Switching OpenCode sessions or projects unloads the TUI plugin. That only disconnects the chip for a moment; the daemon keeps Vox Code up so it can reconnect. Quitting OpenCode entirely stops it after a few seconds with no TUI. `/vox-off` stops it immediately.

Tools the voice model can call: `list_sessions`, `create_session`, `prompt_session` (non-blocking), `abort_session`, `session_status`, `reply_permission`, `focus_session`.

Parallel workers on the **same checkout** can overwrite each other. Ask for a separate directory or git worktree when you spawn a second editor.

## Tests

```bash
npm test
```

Manual: `/vox-on` → hear a greeting (if Realtime + speakers work) → “create a session titled ping and ask it to list files” → `/vox-status` shows an owned session.

## Limits

- No browser/WebRTC path
- No wake word
- Permissions are not auto-approved; Vox Code will ask you
- Headless `opencode serve` without a TUI has no chip; the server plugin still exposes `vox_status`
