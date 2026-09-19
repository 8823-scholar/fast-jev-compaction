# jev-delegate

Claude Code function-hook plugin. It watches how much work the main model does
itself in a turn and, at checkpoints, asks [Jev](https://docs.typesafe.ai)
whether what remains is the execution of a plan that is already settled. When
it is, the model is told to write a brief and hand the rest to a subagent.

## Why

A capable main model tends to keep heavy work for itself. Asking it whether it
should delegate is the judgement that already fails, and a plain "after N tool
calls" rule fires while it is still investigating or when it is nearly done.
Jev is an outside judge that costs a fraction of a cent and half a second.

Deciding from the user's prompt alone does not work: prompts are short and
depend on the conversation ("fix the others the same way"), and their size does
not show. The check therefore runs mid-turn, when the assistant has said what
it is going to do.

## How it works

- `turn.start` resets the count. `tool.call` counts every call of the main
  loop; a subagent's calls are not counted, and a turn that has called `Agent`
  is left alone.
- At `afterCalls` own calls, and again at growing distances (12, 25, 40, 60,
  then every 24 for the default 12), Jev gets the user's prompt, what the
  assistant said so far in the turn (last 5 messages, 700 characters each) and
  its last 12 calls as one line each.
- Five `noul` questions: is there a settled plan, is what remains the execution
  of it, does it need the user, is the work nearly finished, is the assistant
  still investigating. The first two at or above 0.5 and the other three below
  is a hand-over.
- On a hand-over the tool result of that call carries a note only the model
  reads: write a self-contained brief and call the Agent tool with
  `jev-delegate:worker` on `delegateModel`, or say in a sentence why not. The
  nudge is logged with `$.ui.log`. A failed check is logged and changes nothing.

With `logSpawns` (on by default) every started subagent also gets one line in
the transcript with the model it really runs on, whoever started it:

```
jev-delegate: jev-delegate:worker "fxassets 多通貨対応の実装" → claude-opus-5 (asked for opus)
jev-delegate: general-purpose "repository survey" → claude-fable-5-1
jev-delegate: fork "worker fork" → claude-fable-5-1
```

An agent started without a model inherits the main loop's, which is the case
worth seeing. `agents/worker.md` is the receiving end: an Opus agent that carries out a brief,
verifies, and reports what it changed, how it checked, what it left out and
what it assumed.

On replayed heavy turns of real sessions (408 checkpoints) the check fired at
one checkpoint in five; 62% of those moments had 15 or more own calls still
ahead (47% for a plain count rule) and 7% had fewer than 5 (16%). It judges the
size and shape of what remains, not whether a subagent would do it well.

## Install

Function hooks are early access: set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

```sh
claude plugin marketplace add 8823-scholar/fast-jev-compaction
claude plugin install jev-delegate@fast-jev-compaction
```

Credentials work as in fast-jev-compaction: `TYPESAFE_API_KEY`, or with the
`provider` option set to `cloudflare`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` (process environment first, then `settings.json` `env`).

| Option | Default |
| --- | ---: |
| `afterCalls` | `12` |
| `delegateModel` | `opus` |
| `logSpawns` | `true` |
| `provider` | `typesafe` |
| `model` | `jev-latest` |
| `apiKey`, `cloudflareAccountId`, `cloudflareGatewayId`, `baseUrl` | — |

`src/jev.ts` is a copy of the Jev transport of fast-jev-compaction, because an
installed plugin only has its own folder.
