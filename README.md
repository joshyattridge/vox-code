# Voice coding inside OpenCode

An OpenCode plugin that adds a live **OpenAI Realtime** voice supervisor. You talk in the TUI. It talks back. It drives **multiple OpenCode sessions** that do the actual coding. No browser.

Chip in the prompt row: `○ voice` / `● VOICE` / `● listening`.

OpenCode loads the **server** plugin from `opencode.json` and the **TUI** chip/slash commands from `tui.json` (also copied under `.opencode/tui.json`). Without `tui.json`, `/voice` is just prompt text and there is no chip.

## Run it

```bash
git pull
cd opencode-voice-supervisor && npm install && cd ..
# uses the OpenAI key already in OpenCode (/connect or auth.json)
# mic tools: sox or arecord/aplay
opencode
```

Quit OpenCode fully (`ctrl+c`) and start it again from this repo root. You should see:

- a toast: `○ voice is in the prompt row`
- `○ voice` on the right of the prompt
- `/voice` in slash autocomplete (same list as `/review`)

Then `/voice` or `Ctrl+Shift+V`. Details: [opencode-voice-supervisor/README.md](opencode-voice-supervisor/README.md).
