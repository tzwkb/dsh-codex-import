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

Physical layout — plain concatenated zstd frames:

- **Frame 1**: the `session` header record as one JSON line plus `\n`, nothing else.
- **Frame 2+**: event lines, each `\n`-terminated.

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

## Codex rollout inventory

One conversation spans one or more `rollout-*.jsonl` files sharing a
`session_id`; segments are time-contiguous, so ordering by record timestamp
(then `ordinal`) reproduces it without duplication.

**Select by the timestamp in the filename** (`rollout-YYYY-MM-DDTHH-MM-SS-…`),
never by mtime: Codex rewrites old rollouts, so a stale file can carry today's
mtime and silently corrupt a "recent sessions" selection.

**Never take the session id from the filename.** The suffix looks like one and
matches `session_meta.session_id` for current Codex Desktop builds, but across a
300-file sample it matched only 8% of the time — older builds put a per-file
uuid there. The id must come from the record.

**`session_meta` is always the first line** (400/400 sampled) and carries the
`session_id`, so `collectConversations` decides id filtering from the first
record alone: `--session <id>` over a 4.5 GB corpus reads kilobytes, not
gigabytes.

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
- **Only the plugin can import images.** The standalone CLI has no attachment
  store, so `runImport` takes an optional `saveImages`; without it images are
  counted as skipped and reported loudly rather than dropped silently. That is
  why `bin/import-codex.mjs` warns instead of importing them.

Images are admitted one at a time so a single refusal (unsupported media type,
too many pixels, oversized) costs that image only, and refusals are reported.
The store accepts `image/png`, `image/jpeg`, `image/webp`, and `image/gif`.

| Codex record | Mapping |
| --- | --- |
| `session_meta` | session header (`cwd`, `model_provider`, `model`) |
| `event_msg` `task_started` / `task_complete` / `turn_aborted` | `turn/start` / `turn/end`; aborted and errored completions become `interrupted` |
| `response_item` `message` (role `user` / `assistant`) | `user/message` / `assistant/message` |
| `response_item` `message` (role `developer`) | dropped — Codex app context |
| `response_item` `function_call` / `custom_tool_call` | `tool/call` + content block |
| `response_item` `function_call_output` / `custom_tool_call_output` | `tool/result` |
| `response_item` `reasoning` | plaintext `summary` only, as a `reasoning` block |
| `response_item` `tool_search_call` / `tool_search_output` | `tool/call` / `tool/result` (`tool_search`) |
| `response_item` `web_search_call` | `tool/call` (`web_search`); no output record exists |
| `response_item` `agent_message` | dropped — inter-agent envelope, mostly encrypted |
| `compacted`, `world_state`, `turn_context`, `token_usage_record`, `inter_agent_communication_metadata` | dropped — context plumbing, not transcript |
| `event_msg` `item_completed`, `token_count`, `thread_settings_applied` | dropped |

## What Codex injects as the user's own words

Codex records its machine context as `role: "user"` items, so a naive import
opens the session with scaffolding instead of the human's prompt — and the
harness derives the session title from that first message. Drop messages whose
text starts with one of these tags:

`<recommended_plugins>`, `<environment_context>`, `<skill>`, `<turn_aborted>`,
`<in-app-browser-context>`, `<app-context>`, `<user_instructions>`,
`# AGENTS.md instructions`.

`# Files mentioned by the user:` is the exception: that envelope wraps the real
prompt after a `## My request for Codex:` marker, so extract that section
instead of dropping the message. Over-filtering silently deletes things the
human actually typed, which is worse than keeping scaffolding.

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
