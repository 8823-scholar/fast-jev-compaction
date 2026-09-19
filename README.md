# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note: status, size and the first
   `resultHeadChars` characters (`ok, 4213 chars, starts: …`), so Jev judges an
   output it has at least seen the start of.
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol).
   The stages from collapsing old messages onwards delete the texts that say
   why a call matters, so they are only used with `windowTokens: 0`; otherwise
   a history that needs them is judged in windows (step 8).
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default). Jev itself accepts 32k
   tokens of state plus the longest question and 64k per request, and the
   estimate can run 9% under the real count, so about 29k / 58k are the
   highest safe settings. The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold`, or the call's input is at most
     `keepCallInputChars` long → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.

   Small calls (a command, a path, a pattern) always stay because they are the
   assistant's record of what it already tried; without it, it repeats itself.
   Calls with a large input (a written file, an edit) follow Jev's answer.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

8. **Windows.** A long history is cut into windows of about `windowTokens` of
   history each. Every window gets its own state: its messages with the texts
   kept readable (tool inputs up to 1000 characters, texts up to 1600), a
   quarter window of neighbouring messages on each side for context, the
   goal, and `user_notes`. The notes come from one extra pass that shows Jev
   everything the user typed and asks, per message, whether it tells the
   assistant to keep something or says something will be needed again; the
   messages at or above `keepThreshold` travel with every window that does
   not already show them. Each call is asked about in exactly one window,
   windows without a candidate call are skipped, and up to eight requests run
   at once. A 1200-message session is about 25 windows and a few seconds.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

Jev is also served by Cloudflare as the model `typesafe/jev`. With
`provider: 'cloudflare'` the request goes to
`https://api.cloudflare.com/client/v4/accounts/<account>/ai/run` as
`{ model: 'typesafe/jev', input: { state, questions } }` with a Cloudflare API
token (`CLOUDFLARE_API_TOKEN`) and account id (`CLOUDFLARE_ACCOUNT_ID`); a
`{ result, success }` envelope around the answers is unwrapped. Cloudflare
routes every such request through an AI Gateway and bills it from that
gateway's credits (Unified Billing) or a TypeSafe key stored on it (BYOK);
without either the request fails with `402 Insufficient balance`. Set
`cloudflareGatewayId` (`CLOUDFLARE_AI_GATEWAY_ID`) to pick the gateway (the
`cf-aig-gateway-id` header); otherwise the account's default gateway is used.
`baseUrl` replaces the whole URL for either provider.

```ts
const result = await compactMessages(transcript, {
  provider: 'cloudflare',
  cloudflareAccountId: '<account id>', // or CLOUDFLARE_ACCOUNT_ID
  cloudflareGatewayId: 'default', // optional, or CLOUDFLARE_AI_GATEWAY_ID
});
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `provider` | `typesafe` | `typesafe` (System One API) or `cloudflare` (Workers AI) |
| `apiKey` | `TYPESAFE_API_KEY` / `CLOUDFLARE_API_TOKEN` | Credential of the provider (`compactMessages`/`JevClient`) |
| `cloudflareAccountId` | `CLOUDFLARE_ACCOUNT_ID` | Account id for the `cloudflare` provider |
| `cloudflareGatewayId` | `CLOUDFLARE_AI_GATEWAY_ID` | AI Gateway to route `cloudflare` requests through (optional) |
| `model` | `jev-latest` | Jev model name; ignored by `cloudflare` |
| `baseUrl` | provider endpoint | Full request URL override (e.g. an AI Gateway URL) |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `windowTokens` | `8000` | History per window when a long conversation is judged in windows; `0` never splits |
| `resultHeadChars` | `200` | Characters of each tool output shown to Jev in the state; `0` shows only status and size |
| `keepCallInputChars` | `600` | Calls with an input up to this size are never removed, only their results; `0` lets Jev decide |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.
- A window only shows its own part of the conversation. A reason to keep a
  call that the user states elsewhere reaches it through `user_notes`; a
  reason that only the assistant states elsewhere does not.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.

To call Jev through Cloudflare instead, set the `provider` option to
`cloudflare` and provide a Cloudflare API token with Workers AI access plus
the account id, either as the `apiKey` / `cloudflareAccountId` options or in
the environment:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "CLOUDFLARE_API_TOKEN": "<token>",
    "CLOUDFLARE_ACCOUNT_ID": "<account id>",
    "CLOUDFLARE_AI_GATEWAY_ID": "<gateway id, optional>"
  }
}
```

The token needs `Workers AI Read` and `Workers AI Edit`. Jev on Cloudflare is
billed through AI Gateway, so the gateway (the account's default one, or the
one named by `CLOUDFLARE_AI_GATEWAY_ID` / `cloudflareGatewayId`) must hold
credits or a stored TypeSafe key; its logs then show each compaction request.
An authenticated gateway additionally needs `AI Gateway Run` on the same
token. The `model` option is not sent to Cloudflare.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Second plugin: jev-delegate

The marketplace also carries [`plugins/jev-delegate`](plugins/jev-delegate/README.md),
an unrelated use of Jev: a mid-turn check that tells the main model to hand a
settled plan to a subagent. Install it with
`claude plugin install jev-delegate@fast-jev-compaction`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
