# Format contract

Reverse-engineered from the installed harness and from Codex's own logs. Read
this when extending the converter, or when a log is rejected.

## The harness validates a log three times, and the weakest check is not enough

`lib/verify.js` runs all three. Every rule below was found by running a real
check, never by reading the format:

| # | Symptom | Rule |
| --- | --- | --- |
| 1 | `corrupt Zstandard session log: first frame is not exactly one header line` | Frame 1 is the header line alone; events go in later frames |
| 2 | `session event "assistant/message" is surface-eligible and requires a surfaceOp marker` | Four event types need a top-level `surfaceOp` |
| 3 | `session event at seq N lacks an identified message` | Every message event needs a non-empty string `id` |
| 4 | `seed assistant/message at index N has invalid settlement fields` | `assistant/message` needs numeric `turn`, numeric `step`, **and a `stream` Array** |
| 5 | `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` | Every tool result must be preceded by an assistant message carrying a matching `tool-call` **content block** |

Checks 1–3 surface in `validateStoredEvents` (listing/read). Check 4 appears
only on the restore path (`assertAssistantSettlementShape`). Check 5 appears
only when the conversation is **continued** — no harness validator covers it,
so `lib/verify.js` asserts it directly.

The failure mode this table exists to prevent: a log that lists, resumes, and
still cannot be continued. Two earlier versions of this importer passed checks
1–3 and 1–4 respectively and were still unusable.

Never "fix" a rejection by relaxing a check — the harness applies the same rules
when it lists, resumes, and continues the session.

## DSH session v3 physical format

Path: `<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v3.jsonl.zstd`

Encoding (mirror `dsh-session-persistence-jsonl`; do not invent):

- `projectKey`: `/ \ :` collapse to one `-`; `[A-Za-z0-9._-]` kept; anything
  else becomes `~XXXX` (uppercase hex of the UTF-16 code unit); wrapped as
  `--<key>--`, leading separators stripped, truncated to 251 chars.
  A space becomes `~0020`; `译` becomes `~8BD1`.
- `encodeSegment`: the same escaping without the `--` wrapper.
- `seq` is contiguous from 0 across all events (the header carries none).
- Directory mode `700`, log mode `600`.

Physical layout — concatenated, independently checksummed zstd frames:

- **Frame 1**: the `session` header record as one JSON line plus `\n`, nothing else.
- **Frame 2+**: event lines, each `\n`-terminated.

### The frame count is a continuation signal

This importer writes a session as exactly **two** frames: the header, then the
whole event stream in one batch. The running harness does not — it appends one
frame per event batch, so a session it has continued has three frames, then
four, and so on (an eight-turn session was observed at 200 frames).

That difference is what makes a refresh safe. A log at two frames has not been
continued, so replacing its file cannot delete a turn; a log with more frames
has been, and is left alone. Pairing the frame count with a digest of the body
covers the remaining case — a log the harness rewrote wholesale, which can fold
back down to two frames while carrying turns this importer never wrote.

Frame boundaries are read from the standard Zstandard frame header and block
headers. A zstd magic sequence can occur inside compressed data, so scanning for
that byte pattern is not sufficient; `lib/verify.js` walks each block, accounts
for optional checksums, and only then passes the exact frame slice to Node's
decompressor. Truncated blocks and reserved header values are rejected before a
session can be classified as importer-owned.

## DSH event mapping

| Event | Notes |
| --- | --- |
| `session` (header) | `{type, version: 3, id, createdAt, cwd, isSeeded, delegationDepth}`; `id` conventionally `session-<uuid>` |
| `permission/preset`, `sandbox/mode`, `approval/policy` | Emitted once up front; informational |
| `turn/start` / `turn/end` | `data: {turn}`; end carries `data.reason.kind` (`completed`, `interrupted`) |
| `step/start` / `step/end` | `data: {turn, step}`; one step = one model invocation |
| `user/message` | `surfaceOp: "append"`; `data.id` required; carries **no** `turn`/`step` |
| `assistant/message` | `surfaceOp: "append"`; `data.message.id` required; `data` also carries `turn`, `step`, `stream: []` |
| `tool/call` | `data: {turn, step, callId, name, arguments}`; `arguments` is a JSON **string** |
| `tool/result` | `surfaceOp: "append"`; `data.message` needs `id`, `role: "user"`, `source.kind: "tool"`, content `{type:"tool-result", toolCallId, content:[{type:"text",text}], isError}`; top-level `sourceEventSeqs: [<seq of the tool/call>]` |

Surface-eligible types requiring `surfaceOp` — exactly these four:
`system/message`, `user/message`, `assistant/message`, `tool/result`.

A `tool/result` may only carry `sourceEventSeqs`; `assistant/message` must not.

The event envelope is closed: the restore path allows only `type`, `seq`,
`time`, `data`, `surfaceOp`, `sourceEventSeqs`, and `ignorable` at the top
level. If a `request/header` is emitted at all, its `data.reason` must be one of
`initial`, `resume`, `change`, or `series` — the converter omits that event
entirely, which is valid.

The importer reduces string, content-item array, and common structured tool
outputs (`content`, `body`, and `success`) to readable text. Completion events
such as `exec_command_end` are correlated by `call_id`; a non-zero exit code,
explicit failure, error payload, or failed/cancelled status sets
`tool-result.isError`. The CLI reports failed tool results separately from
repaired or missing calls.

### Why tool calls need two representations

The provider adapter (`dsh-llm-deepseek`) builds the wire `tool_calls` array
from **`tool-call` content blocks on the assistant message**:

```js
const toolCalls = message.content.filter((block) => block.type === "tool-call")
```

The `tool/call` **event** is bookkeeping; it is not what the provider reads.
Every call therefore needs both: an event (for the session log) and a block on
the assistant message of the same step (for the next request). A bare event
leaves its result orphaned and the next turn fails.

Codex model responses that consist only of tool calls (no text) have no
assistant message to hang the block on, so the converter synthesizes one. The
`synthesized` counter in the CLI output reports how many times that happened.

An interrupted rollout can contain a `function_call_output` without its
preceding call. Emitting that result alone would pass storage validation but
would fail on the next provider request. The converter inserts a
`codex_orphaned_tool` call with the recovered output, increments
`repairedTools`, and reports the repair so the source rollout can be inspected.
The inverse can happen when a run is cancelled after the model emits a call:
before closing that step the converter appends a deterministic error result,
`[Codex import: the tool call was recorded without an output]`, and counts the
repair as well. This keeps the provider's tool-call balance closed at the end of
the imported history.

## Codex rollout inventory

One conversation spans one or more `rollout-*.jsonl` or
`rollout-*.jsonl.zst` files. Older files identify themselves with
`session_meta.payload.session_id`; newer Codex builds write a per-segment
`payload.id` and may append lineage metadata whose `session_id` is the
conversation root. The importer groups by that root, retains every source id
for `--session` selection, skips records marked as sub-agent transcripts, and
folds cumulative duplicate messages before ordering by timestamp and `ordinal`.

**Select by the timestamp in the filename** (`rollout-YYYY-MM-DDTHH-MM-SS-…`),
never by mtime: Codex rewrites old rollouts, so a stale file can carry today's
mtime and silently corrupt a "recent sessions" selection.

**Never take the session id from the filename.** The suffix looks like one and
matches `session_meta.session_id` for current Codex Desktop builds, but across a
300-file sample it matched only 8% of the time — older builds put a per-file
uuid there. The id must come from the record.

The importer scans a bounded metadata prefix from each file. It uses the first
metadata id as the file's own source id, the last lineage/root id when present,
and the legacy `session_id` fallback when no lineage exists. That lets
`--session <id>` select a conversation without loading every body; conversion
then reads one selected conversation at a time. Codex may compress cold files
as `.jsonl.zst`; the metadata probe recognizes them and decompresses the file
to inspect its metadata before conversion loads the selected records.

## Images

Codex records an attached image as a base64 data URL inside the message content:

```json
{"type": "input_image", "image_url": "data:image/jpeg;base64,/9j/4AAQ..."}
```

DSH stores images content-addressed under `$DSH_HOME/attachments/v1/objects/
<first-2-hex>/<sha256>` and references them from a message content block:

```json
{"type": "image", "attachment": {"attachmentId": "sha256:…", "mediaType": "image/webp", "width": 1280, "height": 928, "bytes": 100434}}
```

**The reference must come from `attachments.saveImages()`.** The store
*normalizes* an image before hashing it — a JPEG can land as WebP at a
different size — so the stored bytes are not the input bytes and the
`attachmentId` cannot be computed from the Codex payload. Writing the blob by
hand and reconstructing the reference is therefore not an option; the store
validates the digest against its own normalized output.

That has two consequences the code is built around:

- The conversion runs in **two phases**: `admitImages` awaits the store for
  every distinct image, then the synchronous `buildRecords` looks each one up by
  the sha256 of its *original* bytes (a lookup key only, never a stored
  identifier) and emits the block.
- `runImport` takes an optional `saveImages`. The composed plugin supplies the
  active store, and the standalone CLI opens the local store when available;
  callers that omit it get a loud count of skipped images rather than silent
  data loss. `--dry-run` deliberately omits the callback so a read-only check
  cannot create attachment objects.

Images are admitted one at a time so a single refusal (unsupported media type,
too many pixels, oversized) costs that image only, and refusals are reported.
Inline base64 is size-checked before decoding (`MAX_IMAGE_BYTES` defaults to
64 MiB), so a pathological rollout cannot allocate an unbounded buffer merely
by being scanned.
The store accepts `image/png`, `image/jpeg`, `image/webp`, and `image/gif`.

| Codex record | Mapping |
| --- | --- |
| `session_meta` | session header (`cwd`, `model_provider`, `model`) |
| `event_msg` `task_started` / `task_complete` / `turn_aborted` (and App Server `turn_*` aliases) | `turn/start` / `turn/end`; aborted and errored completions become `interrupted` |
| `event_msg` `user_message` | Used as a crash-safe user-message fallback when no matching `response_item` exists; duplicate telemetry is ignored |
| `response_item` `message` (role `user` / `assistant`) | `user/message` / `assistant/message` |
| `response_item` `message` (role `developer`) | dropped — Codex app context |
| `response_item` `function_call` / `custom_tool_call` | `tool/call` + content block |
| `response_item` `function_call_output` / `custom_tool_call_output` | `tool/result` |
| `response_item` `local_shell_call` / `shell_call` (and their outputs) | `tool/call` / `tool/result`; structured output text is preserved |
| `response_item` `reasoning` | plaintext `summary` only, as a `reasoning` block |
| `response_item` App Server `userMessage` / `agentMessage` / `plan` | normalized to the corresponding user or assistant message |
| `response_item` `commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall` / `webSearch` | normalized to a paired tool call/result; structured output and failure status are retained |
| `response_item` `tool_search_call` / `tool_search_output` | `tool/call` / `tool/result` (`tool_search`) |
| `response_item` `web_search_call` | `tool/call` + generated successful placeholder result when Codex has no output record |
| `response_item` `imageGeneration` / `image_generation_call` (including `result.b64_json`/`b64Json`) | balanced `image_generation` call/result with an attachment-store image when the payload contains a supported image |
| `response_item` `agent_message` | readable text retained as an assistant message; encrypted-only envelopes are omitted |
| `compacted`, `world_state`, `turn_context`, `token_usage_record`, `inter_agent_communication_metadata` | dropped — context plumbing, not transcript |
| `event_msg` `exec_command_end` / other call completion events | correlated by `call_id`; non-zero exit, error, or failed status marks `tool/result.isError` |
| `event_msg` `item_completed` with `UserMessage` / `AgentMessage` | crash-safe fallback message when the matching `response_item` is absent; mirrored copies are de-duplicated |
| `event_msg` `item_completed` with other items, `token_count`, `thread_settings_applied` | dropped — context plumbing, not transcript |

## What Codex injects as the user's own words

Codex records its machine context as `role: "user"` items, so a naive import
opens the session with scaffolding instead of the human's prompt — and the
harness derives the session title from that first message. Drop messages whose
text starts with one of these tags:

`<recommended_plugins>`, `<environment_context>`, `<permissions instructions>`,
`<skill>`, `<turn_aborted>`, `<in-app-browser-context>`, `<app-context>`,
`<user_instructions>`, `<pending_input>`, `<codex_internal_context>`,
`<user_shell_context>`, `<request_id>`, `<model>`, `<turn_id>`, or
`# AGENTS.md instructions`.

`# Files mentioned by the user:`, `# Applications mentioned by the user:`, and
`# Context from my IDE setup:` are envelopes. When they contain a
`## My request for Codex:` (or `## My request:`) marker, the importer extracts
the human section; a pure envelope is dropped. The same rule applies to the
Codex agent-history preamble.

## Codex reasoning cannot be decrypted

`reasoning.encrypted_content` is a Fernet token (AES-128-CBC + HMAC-SHA256):
version byte `0x80`, 8-byte embedded timestamp, 16-byte IV, ciphertext in
16-byte blocks, trailing 32-byte HMAC. The key is held server-side, the Codex
client never decrypts the field (it only parses and round-trips it), and
`~/.codex/auth.json` holds OAuth tokens rather than key material. Do not attempt
decryption and do not promise it.

What *is* recoverable: `reasoning.summary`, plaintext for roughly a third of
records (`summary_text` entries such as `"**Planning read-only repository
analysis**"`). The converter emits these as `{type:"reasoning", text}` blocks.
`reasoning.content` is always null in the corpus, and `event_msg`
`item_completed` `Reasoning` items duplicate the same summaries exactly — no
additional plaintext exists.

## Memory and publication safety

Discovery first builds lightweight references containing only each rollout path,
its filename timestamp, and ids read from a bounded metadata prefix. Conversion
then loads and releases one conversation at a time. This keeps a multi-gigabyte
Codex history from becoming one giant in-memory object; `collectConversations`
remains available for callers that explicitly want the eager API.

The sync path stages a new session beside its destination and renames it into
place only after the source is complete. Existing destination ancestors and log
symlinks are refused, and a malformed source cannot abort valid siblings. State,
manifest, backup, and rollback paths are preflighted before session publication;
symlinked or non-regular metadata targets are refused without replacing them.
State and manifests are written atomically with restrictive permissions. A sync updates
the state file; when it installs or refreshes a session it also writes an
immutable JSON manifest under `codex-import-manifests/<run-id>.json`, updates the
convenience `codex-import-manifest.json`, and keeps the pre-0.2 text file for
compatibility. A no-op sync leaves the previous manifest and its timestamps
untouched. Rollback checks the recorded body digest before removing or restoring
anything, so a session changed after import is skipped. Rollback outcomes are
written separately under `codex-import-rollback-results/`, leaving the archived
import manifest unchanged.

## Defaults and their cost

- Tool output is kept in full by default. It is ~95% of raw volume, so a day of
  conversations can run to several megabytes; `--max-tool-output N` truncates
  each output to N chars when smaller sessions matter more than completeness.
  A truncated output ends with an explicit `[... truncated X of Y chars ...]`
  marker, so the loss is never silent.
- A `compacted` record's `replacement_history` is a recovery source, not
  context plumbing. Most of it repeats messages the log still holds, but some
  exists nowhere else; dropping the record whole loses real turns. Messages are
  matched per conversation by id (falling back to role + body) so the repeats
  are skipped, and the remainder is emitted at the compaction's own position.
  Compaction histories carry only text and images — never tool calls — so
  inserting them cannot orphan a tool result.
- Imported sessions record `workspace-write` / `ask` rather than Codex's
  original sandbox: the records are informational and the resuming harness
  applies its own policy.
- Codex tool names (`exec`, `shell`, …) do not exist in DSH. They are preserved
  verbatim as history the model can read, not as callable tools.

## Verification recipe

```sh
node bin/import-codex.mjs convert --since-hours 24 --out /tmp/import-check --dry-run
node bin/import-codex.mjs convert --since-hours 24 --out /tmp/import-check
node bin/import-codex.mjs verify /tmp/import-check
```

`verify` runs checks 1–5 and refuses to report success for an empty selection.
Passing it proves a log is well-formed — not that the harness can continue it.
To prove continuation, resume a session and send a prompt over ACP, which is the
only headless surface for it (`dsh --profile acp`, JSON-RPC over stdio):

```
initialize → session/list → session/resume → session/prompt → session/close
```

A successful prompt returns `stopReason: end_turn`; the assistant text arrives
as streamed `session/update` notifications rather than in the result payload, so
read the session log if the result looks empty. The harness appends
`session/end-seed` on first resume and the new turn on prompt — the event count
growing is expected, not corruption.

Note that slash commands **cannot** be tested over ACP: `dsh-acp` does not parse
them, and the `acp` profile does not load other profiles' bundles. The plugin's
`DSH_CODEX_IMPORT_SELFTEST=<path>` hook exists for that gap — it records the
registration result from inside a real composition.
