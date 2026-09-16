# Voice coding inside OpenCode

An OpenCode plugin that adds a live **OpenAI Realtime** voice supervisor. You talk in the TUI. It talks back. It drives **multiple OpenCode sessions** that do the actual coding. No browser.

Chip in the prompt row: `○ voice` / `● VOICE` / `● listening`.

## Run it

```bash
cd opencode-voice-supervisor && npm install && cd ..
export OPENAI_API_KEY=sk-...
# mic tools: sox or arecord/aplay
opencode
```

Then `/voice` (or `Ctrl+Shift+V`). Details: [opencode-voice-supervisor/README.md](opencode-voice-supervisor/README.md).
