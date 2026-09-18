# Architecture and feature contracts

## Components

| Component | Responsibility |
|---|---|
| `src/index.ts` | OpenCode server plugin module; registers `voice_status`. Reads the daemon's persisted model, speaker, state and worker ownership. |
| `src/tui.tsx` | TUI plugin module; prompt chips, palette/slash commands, settings dialogs, saved choices and session events. |
| `src/bridge.ts` | Connects/spawns the daemon and forwards state, commands, focus requests and SDK RPC. Disposing a bridge disconnects that TUI only. |
| `src/daemon.ts` | Owns the supervisor and a private Unix socket. Serializes control commands; RPC replies and stop bypass that queue. Tracks focused session/directory per TUI client. |
| `src/supervisor.ts` | Audio/session lifecycle, worker notifications, echo hold, reconnects, duration policies, key management and previews. |
| `src/socket.ts` | Single WebSocket event adapter and bounded startup handshake, with temporary listener cleanup. |
| `src/realtime.ts` | Realtime GA session setup, PCM/transcripts and a single-response tool continuation loop. |
| `src/live.ts` | GPT-Live session setup and Responses delegation. Batches function results through nested lifecycle completion; tracks each active delegation. |
| `src/audio.ts` | SoX/ffplay/ALSA selection, PCM playback, backpressure, process failures and previews. |
| `src/sessions.ts`, `src/tools.ts` | Worker operations, ownership, directory routing, summaries and tool dispatch. |
| `src/context.ts` | Bounded, pull-only snapshot of focused TUI context. |
| `src/auth.ts`, `src/persist.ts` | Voice-only key storage and atomic diagnostic state. |

The daemon uses Node/Bun independently of OpenCode's process. Its `ws` dependency must be resolvable from its installed directory. The installer installs runtime dependencies for staged copies. OpenCode owns TUI dependencies; they are optional peer dependencies of the plugin.

## Session lifecycle

1. A TUI sends its directory, focused session, options and HTTP fallback configuration.
2. Voice remains off until explicitly started. The supervisor resolves the Voice key and starts audio playback, then waits for the provider's configuration acknowledgment (`session.updated` for Realtime, `session.started` for Live).
3. Successful microphone startup completes the connected state. Errors during startup do not leave a connected chip behind.
4. Each transport attempt has a generation number. Old audio, transcripts and connection callbacks cannot modify a newer attempt. Pending tool results cannot write to a closed provider session.
5. Realtime response requests are serialized, including asynchronous worker updates. Tool calls are deduplicated by call ID, results are appended, and continuation waits for all calls and the generating response to finish. Live uses nested Responses terminal events; an empty terminal output array does not discard previously received function calls.
6. Playback completion is separate from generation completion. PCM duration, stream backpressure and echo hold determine when Realtime microphone transmission resumes. A newer packet invalidates earlier completion callbacks.
7. Transient transport/audio errors tear down local resources before scheduling a bounded exponential retry. Stable connection time resets the retry counter. Explicit stop cancels retry and playback waits.
8. Live sends `session.close` and allows up to one second for `session.closed` before releasing the socket. Microphone and speakers stop immediately. Realtime closes its socket directly.

A provider reconnect starts a new conversation; voice history is not restored. Worker sessions survive independently. Ownership is maintained for the daemon lifetime, including provider reconnects and TUI reattachments; restarting the daemon resets its in-memory ownership tracker.

## Worker tools

| Tool | Behavior |
|---|---|
| `current_context` | Pulls the active TUI's bounded snapshot; fails clearly when no context is available. |
| `list_sessions` | Lists current-project sessions and owned workers, including workers in other directories. Unavailable status is `unknown`. |
| `create_session` | Creates/records an owned worker, optionally creates its directory and submits an initial prompt, and requests TUI focus. Reports focus/prompt outcomes and a shared-checkout warning. |
| `prompt_session` | Sends `promptAsync`, accepts an empty HTTP 204 response, and records ownership. Returns acceptance, not completion. |
| `abort_session` | Requests worker cancellation and returns the backend's result. |
| `session_status` | Fetches status, recent assistant text and changed-file counts. A failed status lookup cannot be reported as successful completion. |
| `reply_permission` | Forwards `once`, `always` or `reject` for a specific permission request. Instructions tell the voice model to ask the user first. |
| `focus_session` | Requests navigation in the active TUI; reports whether focus succeeded. |

Session tools accept `session_id: "current"` where applicable. This resolves the active TUI session, and fails on the home screen rather than reusing an old session. Focus and RPC responses are matched to the requesting TUI socket. A disconnected client immediately fails its pending RPCs.

Owned-worker idle/error/permission notifications are forwarded to the voice conversation. Idle reports are deduplicated within a short window. Polling supplements TUI idle events; it does not interpret failed status requests as a completed worker.

## Configuration and storage

See the README for every supported option and command. The active daemon uses options passed by the TUI. Model, speaker and prompt can change while running and reconnect the provider, as required for voice/model changes. Other startup policies should be changed with a full OpenCode restart. API keys are separate from OpenCode's provider authentication.

State snapshots are diagnostic, not a conversation-recovery database. They contain transcript windows and worker IDs, are written by atomic rename with `0600` permissions, and are shown as off when their owning process no longer exists. Failure to write diagnostics does not interrupt audio. Tests use isolated data directories.

## API references

- [OpenCode plugins](https://opencode.ai/docs/plugins/) and the installed `@opencode-ai/plugin` 1.18.31 `PluginModule`/`TuiPluginModule` TypeScript declarations (server and TUI entrypoints).
- [OpenCode configuration schema](https://opencode.ai/config.json) and [TUI schema](https://opencode.ai/tui.json).
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations): GA session shape, function results, response lifecycle, and WebSocket playback responsibilities.
- [GPT-Live session management](https://developers.openai.com/api/docs/guides/live-conversations): transcript windows, continuous audio, commentary/thinking and graceful close.
- [GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation): nested completed function items, terminal snapshots and explicit continuation after every required result.
