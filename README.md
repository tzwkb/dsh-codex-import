# dsh-codex-import

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue.svg)](cordis.patch.yml)
[![Node](https://img.shields.io/badge/Node-18%2B-blue.svg)](https://nodejs.org/)

English | [中文](README_ZH.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that imports Codex CLI/Desktop conversations into DSH as sessions `dsh-tui` can list, resume, and continue. Codex and DSH store conversations in unrelated formats, so neither tool can read the other's history.

> Codex reasoning is encrypted server-side and cannot be decrypted; only its plaintext summaries survive, and those are imported.

## What it does

- Groups Codex rollout segments into conversations. One conversation spans several `rollout-*.jsonl` files that share a `session_id`; file mtime is not a recency signal, and the filename suffix is not the session id.
- Converts each conversation into a DSH session v3 log — turns, steps, messages, tool calls and results, reasoning summaries, and images.
- Recovers the model's thinking as far as it is recoverable: Codex ships reasoning as a server-keyed Fernet token, and about a third of those records also carry a plaintext `summary` that becomes a `reasoning` block.
- Admits attached images through the DSH attachment store, so they render in the transcript and reach the model again.
- Drops Codex's own context injection (`<recommended_plugins>`, `<environment_context>`, `<skill>`, `# AGENTS.md instructions`, …), so the opening turn and the derived session title are the human's words.
- Verifies every converted session with the harness's own validators plus a tool-call pairing check, and **only then** copies it into the sessions root. Existing sessions are never overwritten.
- Writes a rollback manifest, so an import can be undone with one command.

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
/import-codex                      # conversations started in the last 24 hours
/import-codex --since-hours 168    # last week
/import-codex --session <id>       # one Codex session id (repeatable)
/import-codex --max-tool-output 4000  # smaller sessions, at the cost of detail
/import-codex --dry-run            # convert and verify, write nothing
/import-codex --help
```

Start with `--list`. It prints each conversation with its full session id, time span, working directory, and opening prompt, so the scope can be chosen before anything is written. The window is selected by the timestamp **in the filename**, never by mtime — Codex rewrites old rollouts, so a months-old file can carry today's mtime.

The same work is available from a shell, without a running harness:

```sh
node bin/import-codex.mjs list    --since-hours 168
node bin/import-codex.mjs convert --since-hours 24 --out /tmp/import-check
node bin/import-codex.mjs verify  /tmp/import-check
```

The CLI cannot import images: it has no attachment store, and the store re-encodes an image before hashing it, so a durable reference cannot be fabricated. It reports how many images it skipped instead of dropping them silently.

## What survives, and what does not

| | Result |
| --- | --- |
| Messages, tool calls and results | Imported in full. `--max-tool-output N` truncates each tool output to N chars if you need smaller sessions; the default is 0, which keeps everything. |
| Reasoning | Only the plaintext `summary`, for roughly a third of records. The rest is a Fernet token keyed by OpenAI and cannot be read by any client. |
| Images | Imported by `/import-codex` through the attachment store. Skipped, and reported, by the CLI. |
| Codex-injected context | Dropped. The `# Files mentioned by the user:` envelope is unwrapped rather than dropped, because it wraps the human's actual prompt. |
| Compaction markers, world state, token counts, inter-agent envelopes | Dropped: context plumbing rather than conversation. |
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
- Node.js 18+ (the plugin runs inside the harness)
- Codex data under `$CODEX_HOME/sessions` (default `~/.codex/sessions`)

## Development

Because the install is a copy, edits do not reach the harness on their own:

```sh
scripts/reinstall.sh          # re-copies into the dsh-tui profile, then restart dsh-tui
```

`scripts/reinstall.sh <profile>` targets another profile. Re-running `dsh plugin add` refreshes an existing `file:` dependency in place; removing first is not required.

Before changing `lib/convert.js` or `lib/verify.js`, read [`docs/formats.md`](docs/formats.md). `DSH_CODEX_IMPORT_SELFTEST=<path>` makes the plugin record its command registration to a file, which is the only headless way to confirm the command registered — `dsh-acp` does not parse slash commands, and the `acp` profile does not load another profile's bundles.

## License

MIT — see [LICENSE](LICENSE).
