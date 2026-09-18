# Testing

## Commands

Use Node.js 22.6+; CI uses current Node 22 and 24 on Linux and macOS.

```sh
npm ci
npm test                  # unit/component tests; paid smoke tests skipped by default
npm run test:e2e          # real local sockets and HTTP with controlled endpoints
npm run typecheck         # all source and test TypeScript
npm run test:all          # all three checks above
npm pack --dry-run        # inspect the distributable file list
```

Install SoX to run the raw-stream fidelity regression; otherwise that test is explicitly skipped. Tests create temporary data directories via `test/setup.mjs` and do not overwrite installed daemon state. The deterministic suite requires no API key, OpenCode process, microphone or speakers.

## Automated scenarios

| Area | Coverage |
|---|---|
| Native audio | Full jittered PCM through real SoX; first-chunk and final-tail truncation regressions; consecutive response finalization; latest-assistant WAV integrity and silence metrics; stream backpressure and byte order; missing executable and process exit; PCM sample alignment. |
| Realtime | GA payload, readiness acknowledgment, tool deduplication, staggered parallel calls, response continuation, worker-update queuing, VAD response race, late events after close. |
| GPT-Live | Session configuration, nested tool calls, completion before continuation, duplicate calls, bounded transcript windows, quiet context, audio decode, graceful close. |
| Lifecycle | Echo gating, overlapping completion callbacks, stop during startup/playback, failed key lookup, playback errors, reconnect, inactivity, billing warning and maximum duration. |
| Daemon/bridge | Real Unix-socket attach/reattach, TUI exit policy, RPC, focus, queue deadlock regression, per-TUI directory/session context, home-screen reset. |
| Tools | Context, create/prompt/focus/list/status/abort/permissions, HTTP 204 acceptance, directory/worktree handling, ownership and unknown-status handling. |
| Settings/storage | Model/speaker/prompt changes, voice preview requests, key validation/storage, private atomic state and dead-daemon status. |
| Plugin integration | Entrypoint/type compatibility, full TUI JSX compilation through OpenTUI's Solid transform, package metadata, installer CLI/dry-run and TUI command/config registration checks. |

`test/e2e/voice.test.ts` runs both backends through:

```text
TUI bridge → Unix socket → real daemon/supervisor → local provider WebSocket
                                   ↕
                             tool dispatch
                                   ↕
              Unix-socket SDK RPC → HTTP client → local worker server
```

It asserts worker-side requests and results, focus navigation requests, owned-session state, exact PCM input/output bytes, a TUI detach/reattach, fresh home context, network loss/reconnect and explicit stop. OpenAI/model output and the OpenCode worker HTTP service are controlled fixtures; audio is in memory. These are local end-to-end tests, not a rendered-terminal or physical-device test.

## Real provider smoke tests

These opt-in checks make billable API requests. Supply an OpenAI Platform key through your environment without checking it into the repository:

```sh
OPENAI_REALTIME_SMOKE=1 npm run test:realtime-smoke
OPENAI_LIVE_SMOKE=1 npm run test:live-smoke
```

Both require `OPENAI_API_KEY`. You can set both flags to exercise both backends in one invocation. Realtime's model can be selected with `OPENAI_REALTIME_MODEL`. Tests verify successful startup and non-silent 24 kHz PCM output. Live sends synthetic silent input so its continuous audio engine can progress. They do not access local audio devices, run coding tasks, or prove subjective speech quality. Hard timeouts close sessions on failure.

## Hardware and rendered-TUI acceptance

After installing an updated plugin, fully quit and restart OpenCode. On the same machine as your microphone/speakers:

1. **Commands:** check both prompt chips, click/toggle, `Ctrl+Shift+V`, `/voice`, `/voice-on`, `/voice-off`, `/voice-status`, and the Voice palette entries.
2. **Credentials:** open `/voice-key`; verify masking, Escape cancellation, invalid-key feedback, replacement/status and removal using a test account.
3. **Complete replies:** start Realtime and ask for a two-sentence reply. Listen through its final word. Speak after it finishes; verify the next reply arrives without feedback or a cut-off first syllable.
4. **Full duplex:** select GPT-Live, use headphones and speak while it replies. Confirm both audio directions remain usable.
5. **Workers:** ask it to create a session and list files. Confirm focus, accepted prompt, the actual worker result and its spoken completion. Try status, cancellation and a worker permission request.
6. **Settings:** preview and choose another speaker; edit/reset the speaking prompt; restart OpenCode and check the saved choices. Confirm the voice and coding-session model pickers are independent.
7. **Navigation:** change sessions/projects and return home while connected. Confirm audio persists and “current session” never targets the previous project from home.
8. **Recovery:** disconnect/reconnect the network and unplug/reselect an audio device. Confirm visible error/reconnect status, recovery and prompt `/voice-off` behavior.
9. **Exit:** quit OpenCode. With default policy, verify audio stops after the 15-second TUI reconnection window.

This checklist covers real acoustic feedback, OS permissions, device selection, key rendering and terminal interaction that the headless automated suite cannot validate.
