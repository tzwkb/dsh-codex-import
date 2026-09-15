# dsh-codex-import

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue.svg)](cordis.patch.yml)
[![Node](https://img.shields.io/badge/Node-22.19%2B-blue.svg)](https://nodejs.org/)

English | [中文](README_ZH.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that imports Codex CLI/Desktop conversations into DSH as sessions `dsh-tui` can list, resume, and continue. Codex and DSH store conversations in unrelated formats, so neither tool can read the other's history.

> Codex reasoning is encrypted server-side and cannot be decrypted; only its plaintext summaries survive, and those are imported.

## What it does

- Groups Codex rollout segments into conversations. One conversation spans several `rollout-*.jsonl` or compressed `rollout-*.jsonl.zst` files; newer files may identify the segment with `payload.id` and the conversation root with the metadata lineage. The filename suffix is not the session id, and a paginated page names its page only in the filename — which is also accepted by `--session`.
- Converts each conversation into a DSH session v3 log — turns, steps, messages, tool calls and results, reasoning summaries, and images.
- Imports **Codex's current compaction window by default** rather than replaying the whole rollout — see [Why the default is not a full replay](#why-the-default-is-not-a-full-replay).
- Bounds every single text (default 262,144 characters), keeping head and tail around an explicit marker: one oversized unit is the one shape compaction cannot repair, so it is handled at import time.
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
/import-codex --since-hours 168    # conversations active in the last week
/import-codex --session <id>       # one Codex session id (repeatable)
/import-codex --limit 10           # newest 10 after filtering
/import-codex --project /repo      # this project and its descendants
/import-codex --archived           # include archived Codex sessions
/import-codex --codex-root /backup/codex/sessions  # alternate source
/import-codex --max-tool-output 4000  # smaller sessions, at the cost of detail
/import-codex --max-text-chars 65536  # per-text budget (default 262144; 0 disables)
/import-codex --full-history       # replay everything; only fits one context if small
/import-codex --no-images          # skip attachment admission
/import-codex --dry-run            # convert and verify, write nothing
/import-codex --force              # refresh even a session you continued in DSH
/import-codex --help
```

A bare invocation lists rather than importing everything in range, because the scope should be chosen deliberately. The list prints each conversation with its full session id, time span in local time, working directory, and opening prompt. `--since-hours N` selects conversations with **activity** in that window: one that started inside it, or one Codex is still appending to. Codex keeps a conversation open for days, so the file behind the chat you are in right now can carry a days-old name — the filename timestamp alone would hide it. Activity is proven by the timestamp of the newest record in the file, never by mtime alone, because the paginated rollout migration rewrites cold rollouts and gives a months-old file today's mtime. Every page of a selected conversation is imported: a page file holds only its own turns, so importing the live page by itself would truncate the session.

The same work is available from a shell, without a running harness:

```sh
node bin/import-codex.mjs list    --since-hours 168
node bin/import-codex.mjs convert --since-hours 24 --out /tmp/import-check
node bin/import-codex.mjs sync    --codex-root /backup/codex/sessions --dsh-home /tmp/dsh --dry-run
node bin/import-codex.mjs verify  /tmp/import-check
node bin/import-codex.mjs audit   ~/.dsh/sessions   # read-only: what cannot be compacted
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

An import run never deletes a session or imports one twice: a refresh replaces the file, keeping the directory, any sibling files, and the session id. The explicit rollback command is the one operation that removes a session created by that import.

## Why the default is not a full replay

A rollout is an append-only log, but Codex does not replay it: every `compacted` record replaces the history before it with the summary the record carries. Importing the whole rollout therefore imports history **the model can no longer see**, and a long conversation is easily hundreds of times larger than its own current window — one measured 464 MB rollout replays to about 8.24M tokens against a current Codex window of about 130k.

Size is not the whole problem. DSH condenses history by **replaying the span being condensed to a summarizer**, so once a history exceeds the model window:

- the request cannot be sent, and
- the repair cannot run either, because the summarization call is over the same window.

The session lists, resumes, and then refuses every new turn — and manual compaction cannot rescue it. The default window import exists for that: **the last `compacted` record plus every record after it**, which is the context Codex itself still holds. Earlier snapshots are dropped because the last one summarised them. Conversation metadata (cwd, model, createdAt, title) is still read from the full record list, so a window never loses it.

`--full-history` keeps the old whole-replay behaviour for conversations that genuinely fit one context.

`--max-text-chars N` (default 262,144) is the second guard: a single oversized text is the one shape balanced compaction refuses to split and the tool-result pruner cannot touch. Text beyond the budget keeps its head and tail around `[... N of M chars trimmed during Codex import ...]`, so nothing is lost silently.

## An oversized session is already installed

`--audit` is read-only. It prices the model context of every installed session, names the ones above the advisory (~700k tokens), never rewrites, and never follows a symlink.

```
/import-codex --audit
node bin/import-codex.mjs audit ~/.dsh/sessions
```

The fix is to rebuild it **from Codex**, where the source conversation is intact:

```
/import-codex --session <codex session id> --force
node bin/import-codex.mjs sync --session <id> --force
```

`--force` is required because the installed log is no longer exactly what the importer wrote. It replaces that one session log; the Codex rollout is never modified. The session id and directory stay the same, so `/resume` and workspace state keep working. The rebuilt session should then appear on the clear side of the next `--audit`.

## What survives, and what does not

| | Result |
| --- | --- |
| Messages, tool calls and results | Imported in full, including readable `item_completed` telemetry messages when a normal item is missing. `--max-tool-output N` truncates each tool output to N chars if you need smaller sessions; the default is 0, which keeps everything. Missing calls/results are repaired with explicit placeholders and counted; non-zero exits remain marked as errors. |
| Reasoning | Only the plaintext `summary`, for roughly a third of records. The rest is a Fernet token keyed by OpenAI and cannot be read by any client. |
| Images | Imported through the attachment store, including App Server and telemetry-side user images plus structured image-generation results. Oversized or malformed inline base64 is rejected before allocation; valid image-store refusals are reported, and the transcript keeps an omission placeholder. |
| Codex-injected context | Dropped. The `# Files mentioned by the user:` envelope is unwrapped rather than dropped, because it wraps the human's actual prompt. |
| Compaction markers, world state, token counts, inter-agent envelopes | Dropped: context plumbing rather than conversation. Readable legacy `agent_message` text and messages that survive *only* inside a compaction's `replacement_history` are recovered. |
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
- Node.js 22.19+ (the converter and verifier use Node's native Zstandard API; the DSH ACP runtime requires the same baseline)
- Codex data under `$CODEX_HOME/sessions` (default `~/.codex/sessions`)

## Development

Because the install is a copy, edits do not reach the harness on their own:

```sh
scripts/reinstall.sh          # re-copies into the dsh-tui profile, then restart dsh-tui
```

`scripts/reinstall.sh <profile>` targets another profile. Re-running `dsh plugin add` refreshes an existing `file:` dependency in place; removing first is not required.

Tests use a synthetic Codex corpus and a throwaway `DSH_HOME` under `.test-work`, so they never read your personal history. Verification loads the lockfile-pinned DSH runtime into `.test-runtime`; no global DSH, `~/.dsh`, or `~/.codex` data is touched. The deterministic regression suite also covers malformed input, zstd magic collisions, bounded discovery, live-rollout window selection, dry-run side effects, rollback history, and symlink guards:

```sh
npm run test:setup     # once per clone: download the isolated DSH test runtime
npm test              # regressions, reconcile behaviour, slash command, and ACP resume smoke tests
node scripts/test-sync.mjs --keep     # leave the scratch tree for inspection
```

GitHub Actions runs the same suite, syntax checks, and a publish-content audit on both Ubuntu and macOS, using the minimum supported Node 22.19 and the current Node 24 line, for every push to `main` and every pull request.

`scripts/test-resume.mjs <sessions-root> [session-id] [dsh-home]` hands one **real** session to the isolated `acp` profile to list and resume, which is how a specific conversion is proven loadable by the harness (`DSH_HOME` must be the home the profile resolves, or the list comes back empty):

```sh
DSH_HOME=/tmp/acp-home DSH_TUI_SESSION_ROOT=/tmp/acp-home/sessions \
  node scripts/test-resume.mjs /tmp/acp-home/sessions
```

`test-sync.mjs` covers determinism, install, no-op re-sync, in-place refresh, both refusal cases, `--force`, and the image guard. `test-plugin.mjs` composes the plugin the way the harness does and invokes the handler, because the slash command is the surface that actually gets used and no other test reaches it.

Before changing `lib/convert.js` or `lib/verify.js`, read [`docs/formats.md`](docs/formats.md). `DSH_CODEX_IMPORT_SELFTEST=<path>` makes the plugin record its command registration to a file, which is the only headless way to confirm the command registered — `dsh-acp` does not parse slash commands, and the `acp` profile does not load another profile's bundles.

## License

MIT — see [LICENSE](LICENSE).
