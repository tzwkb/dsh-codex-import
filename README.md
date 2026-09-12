# dsh-codex-import

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue.svg)](cordis.patch.yml)
[![Node](https://img.shields.io/badge/Node-22.15%2B-blue.svg)](https://nodejs.org/)

English | [中文](README_ZH.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that imports Codex CLI/Desktop conversations into DSH as sessions `dsh-tui` can list, resume, and continue. Codex and DSH store conversations in unrelated formats, so neither tool can read the other's history.

> Codex reasoning is encrypted server-side and cannot be decrypted; only its plaintext summaries survive, and those are imported.

## What it does

- Groups Codex rollout segments into conversations. One conversation spans several `rollout-*.jsonl` or compressed `rollout-*.jsonl.zst` files; newer files may identify the segment with `payload.id` and the conversation root with the metadata lineage. File mtime is not a recency signal, and the filename suffix is not the session id.
- Converts each conversation into a DSH session v3 log — turns, steps, messages, tool calls and results, reasoning summaries, and images.
- Recovers the model's thinking as far as it is recoverable: Codex ships reasoning as a server-keyed Fernet token, and about a third of those records also carry a plaintext `summary` that becomes a `reasoning` block.
- Admits attached images through the DSH attachment store, so they render in the transcript and reach the model again.
- Drops Codex's own context injection (`<recommended_plugins>`, `<environment_context>`, `<permissions instructions>`, IDE/application envelopes, `# AGENTS.md instructions`, …), while unwrapping the human section when an envelope contains `## My request for Codex:`.
- Repairs interrupted tool rounds in both directions: a result without its call gets an explicit `codex_orphaned_tool` placeholder, and a call without a flushed result gets a deterministic error result. Both remain resumable and are counted in the report.
- Preserves newer `local_shell_call`/`shell_call` records and correlates Codex completion events, so non-zero exits and failed MCP/patch calls remain visibly marked as tool errors.
- Verifies every converted session with the harness's own validators plus a tool-call pairing check, and **only then** publishes it. Importer-owned two-frame sessions may be refreshed in place; continued, foreign, malformed, or symlinked sessions are left alone.
- Writes an immutable per-run rollback manifest (plus a latest pointer), so an import can be undone safely even after a later no-op run.
- Scans rollouts in bounded memory: inventory keeps paths and timestamps only, then conversion loads one conversation at a time. A targeted `--session` scan reads a bounded metadata prefix before deciding whether to read each body.

## Install

From a clone of this repository:

```sh
dsh plugin --profile dsh-tui add "file:$PWD"
```

pnpm's `file:` protocol copies the package into the profile rather than symlinking it, so the installed copy is independent of the clone. The CLI appends the package to `dsh.profile.bundles` because it declares `dsh.bundle.patch`; nothing else needs configuring. Remove it with `dsh plugin --profile dsh-tui remove dsh-codex-import`.

Restart `dsh-tui` after installing — plugins mount at startup.

## Use

Inside a `dsh-tui` session:

```
/import-codex --list               # see what is available before importing
/import-codex                      # lists too — nothing is written without a scope
/import-codex --since-hours 168    # last week
/import-codex --session <id>       # one Codex session id (repeatable)
/import-codex --limit 10           # newest 10 after filtering
/import-codex --project /repo      # this project and its descendants
/import-codex --archived           # include archived Codex sessions
/import-codex --codex-root /backup/codex/sessions  # alternate source
/import-codex --max-tool-output 4000  # smaller sessions, at the cost of detail
/import-codex --no-images          # skip attachment admission
/import-codex --dry-run            # convert and verify, write nothing
/import-codex --force              # refresh even a session you continued in DSH
/import-codex --help
```

A bare invocation lists rather than importing everything in range, because the scope should be chosen deliberately. The list prints each conversation with its full session id, time span, working directory, and opening prompt. The window is selected by the timestamp **in the filename**, never by mtime — Codex rewrites old rollouts, so a months-old file can carry today's mtime.

The same work is available from a shell, without a running harness:

```sh
node bin/import-codex.mjs list    --since-hours 168
node bin/import-codex.mjs convert --since-hours 24 --out /tmp/import-check
node bin/import-codex.mjs sync    --codex-root /backup/codex/sessions --dsh-home /tmp/dsh --dry-run
node bin/import-codex.mjs verify  /tmp/import-check
node bin/import-codex.mjs sync    --since-hours 24      # into $DSH_TUI_SESSION_ROOT or $DSH_HOME/sessions
node bin/import-codex.mjs rollback --manifest /path/to/codex-import-manifests/<run>.json
```

`convert` writes a directory and stops there, so the result can be inspected first. `sync` is the same pipeline aimed at a live sessions root: convert to a scratch directory, verify, then reconcile session by session. `--dry-run` uses that same scratch-and-verify path and removes the scratch tree afterward; it does not open or mutate the attachment store. Both normal CLI commands open the attachment store directly, so they import images just as `/import-codex` does. `--codex-root` is useful for an archived export, and `--dsh-home` selects a profile's attachment home; an explicit `--into` or `DSH_TUI_SESSION_ROOT` takes precedence for the live sessions root.

## Re-running is incremental

Importing the same conversation again is safe, and cheap when nothing changed. Each session is compared against a fresh conversion by the digest of its event stream, which sorts every session into one of four outcomes:

| | What happens |
| --- | --- |
| Not imported yet | Installed. |
| Byte-identical content | **Nothing is written at all.** A re-run that changes nothing touches no file. |
| Content differs | **Refreshed in place** — same session id and directory, so `/resume` entries and workspace state stay valid. This is how a conversation that grew in Codex, or one imported before a converter change, is brought up to date. |
| Not the file this importer wrote | **Left alone.** |

The last case matters most. DSH appends one zstd frame per event batch, so a session you have continued inside DSH is no longer a two-frame log; rewriting it would delete your turns. A log at two frames whose digest does not match what the importer recorded is one something else rewrote, and is treated the same way. `--force` overrides this, and is destructive by design. A conversion that could not reach the attachment store is also refused rather than allowed to overwrite a log that holds images. A sync writes `codex-import-state.json` beside the sessions root; runs that install or refresh sessions also keep a run-specific JSON manifest under `codex-import-manifests/`. A no-op run preserves the previous manifest and its rollback history, while the text manifest remains only for older scripts.

Nothing is ever deleted, and no session is ever imported twice: a refresh replaces the file, keeping the directory, any sibling files, and the session id.

## What survives, and what does not

| | Result |
| --- | --- |
| Messages, tool calls and results | Imported in full. `--max-tool-output N` truncates each tool output to N chars if you need smaller sessions; the default is 0, which keeps everything. Missing calls/results are repaired with explicit placeholders and counted; non-zero exits remain marked as errors. |
| Reasoning | Only the plaintext `summary`, for roughly a third of records. The rest is a Fernet token keyed by OpenAI and cannot be read by any client. |
| Images | Imported through the attachment store, including App Server and telemetry-side user images plus structured image-generation results. Oversized inline base64 is rejected before allocation; valid image-store refusals are reported. |
| Codex-injected context | Dropped. The `# Files mentioned by the user:` envelope is unwrapped rather than dropped, because it wraps the human's actual prompt. |
| Compaction markers, world state, token counts, inter-agent envelopes | Dropped: context plumbing rather than conversation. Messages that survive *only* inside a compaction's `replacement_history` are recovered. |
| Codex tool names (`exec`, `shell`, …) | Preserved verbatim as history the model can read; they are not callable in DSH. |

An imported image is only *visible* again if the active model accepts images. A
catalog entry without `inputModalities` defaults to text-only, and the harness
then substitutes `[image omitted because this model accepts text only;
attachment sha256:…]` before the request leaves the process — the import is
still correct, but the agent will say it cannot see images.
`deepseek-flash` and `deepseek-v4-flash-vision-exp` declare `["text","image"]`;
`deepseek-v4-flash` and `deepseek-v4-pro` do not. The `acp` profile is pinned to
`deepseek-v4-flash`, so verifying image playback through ACP yields a false
negative.

## Why the format is fussy

DSH validates a session log three times, and the weaker checks are not enough — an import can list, resume, and still fail the next turn. Five rules were each found by running a real check, and each is enforced by `lib/verify.js`:

1. The first zstd frame holds exactly the header line.
2. Four event types are surface-eligible and need a `surfaceOp` marker.
3. Every message event needs a non-empty string `id`.
4. `assistant/message` needs numeric `turn`, numeric `step`, and a `stream` Array.
5. Every tool result needs a matching `tool-call` **content block** on an assistant message — the provider reads `tool_calls` from the blocks, not from the `tool/call` event.

[`docs/formats.md`](docs/formats.md) documents the full contract: the physical layout, the event mapping, the corpus-wide Codex record inventory, and why images and session ids must be handled the way they are.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with the `dsh-tui` profile installed
- Node.js 22.15+ (the converter and verifier use Node's native Zstandard API)
- Codex data under `$CODEX_HOME/sessions` (default `~/.codex/sessions`)

## Development

Because the install is a copy, edits do not reach the harness on their own:

```sh
scripts/reinstall.sh          # re-copies into the dsh-tui profile, then restart dsh-tui
```

`scripts/reinstall.sh <profile>` targets another profile. Re-running `dsh plugin add` refreshes an existing `file:` dependency in place; removing first is not required.

Tests use a synthetic Codex corpus and a throwaway `DSH_HOME` under `.test-work`, so they never read your personal history. Verification loads a pinned DSH runtime downloaded into `.test-runtime`; no global DSH, `~/.dsh`, or `~/.codex` data is touched. The deterministic regression suite also covers malformed input, zstd magic collisions, bounded discovery, dry-run side effects, rollback history, and symlink guards:

```sh
npm run test:setup     # once per clone: download the isolated DSH test runtime
npm test              # deterministic regressions, reconcile behaviour, then /import-codex
node scripts/test-sync.mjs --keep     # leave the scratch tree for inspection
```

`test-sync.mjs` covers determinism, install, no-op re-sync, in-place refresh, both refusal cases, `--force`, and the image guard. `test-plugin.mjs` composes the plugin the way the harness does and invokes the handler, because the slash command is the surface that actually gets used and no other test reaches it.

Before changing `lib/convert.js` or `lib/verify.js`, read [`docs/formats.md`](docs/formats.md). `DSH_CODEX_IMPORT_SELFTEST=<path>` makes the plugin record its command registration to a file, which is the only headless way to confirm the command registered — `dsh-acp` does not parse slash commands, and the `acp` profile does not load another profile's bundles.

## License

MIT — see [LICENSE](LICENSE).
