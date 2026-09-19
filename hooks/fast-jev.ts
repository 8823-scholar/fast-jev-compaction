import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import {
  DELEGATE_QUESTIONS,
  callLine,
  delegateNudge,
  delegateState,
  delegateVerdict,
  isCheckpoint,
  isEditTool,
  type DelegateVerdict,
  type TurnProgress,
} from '../src/delegate.js';
import {
  apiKeyVariable,
  buildJevRequest,
  DEFAULT_MODEL,
  parseJevResponse,
  type JevProvider,
} from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  delegateAfterCalls: 0,
  delegateModel: 'opus',
  logDecisions: false,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  provider: 'typesafe' as JevProvider,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  /**
   * Own tool calls in a turn after which Jev is first asked whether the rest
   * should go to a subagent; 0 never asks.
   */
  delegateAfterCalls: number;
  /** The model the nudge names for the subagent. */
  delegateModel: string;
  /** Log every per-call decision with its probabilities (long; for diagnosis). */
  logDecisions: boolean;
  minReductionRatio: number;
  model: string;
  provider: JevProvider;
  baseUrl?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
};

/** The transport half of the config: what `buildJevRequest` needs beyond the key. */
export type JevEndpoint = Pick<
  HookConfig,
  'provider' | 'model' | 'baseUrl' | 'cloudflareAccountId' | 'cloudflareGatewayId'
>;

function optionProvider(options: PluginOptions): JevProvider {
  const value = optionString(options, 'provider');
  if (value === undefined) return HOOK_DEFAULTS.provider;
  if (value === 'typesafe' || value === 'cloudflare') return value;
  throw new Error(`unknown provider "${value}" (expected typesafe or cloudflare)`);
}

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionBoolean(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'windowTokens',
    'resultHeadChars',
    'keepCallInputChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    delegateAfterCalls: Math.max(
      0,
      Math.floor(optionNumber(options, 'delegateAfterCalls', HOOK_DEFAULTS.delegateAfterCalls)),
    ),
    delegateModel: optionString(options, 'delegateModel') ?? HOOK_DEFAULTS.delegateModel,
    logDecisions: optionBoolean(options, 'logDecisions', HOOK_DEFAULTS.logDecisions),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    provider: optionProvider(options),
  };
  for (const key of ['apiKey', 'goal', 'baseUrl', 'cloudflareAccountId', 'cloudflareGatewayId'] as const) {
    const value = optionString(options, key);
    if (value) config[key] = value;
  }
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, endpoint: JevEndpoint): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, ...endpoint }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error(`${apiKeyVariable(config.provider)} is not configured`);
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

type HookEnv = {
  env: { get: (name: string) => Promise<string | undefined> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
};

type CredentialVariable =
  | 'TYPESAFE_API_KEY'
  | 'CLOUDFLARE_API_TOKEN'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDFLARE_AI_GATEWAY_ID';

/** `$.env.get` requires a literal name, so each variable has its own call. */
function processVariable($: HookEnv, name: CredentialVariable): Promise<string | undefined> {
  switch (name) {
    case 'TYPESAFE_API_KEY':
      return $.env.get('TYPESAFE_API_KEY');
    case 'CLOUDFLARE_API_TOKEN':
      return $.env.get('CLOUDFLARE_API_TOKEN');
    case 'CLOUDFLARE_ACCOUNT_ID':
      return $.env.get('CLOUDFLARE_ACCOUNT_ID');
    case 'CLOUDFLARE_AI_GATEWAY_ID':
      return $.env.get('CLOUDFLARE_AI_GATEWAY_ID');
  }
}

/** An environment variable from the process, then from `settings.json` `env`. */
async function getVariable($: HookEnv, name: CredentialVariable): Promise<string | undefined> {
  const fromEnv = await processVariable($, name);
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** The configured key and, for cloudflare, the account id; both fall back to the environment. */
export async function resolveCredentials($: HookEnv, config: HookConfig): Promise<HookConfig> {
  const resolved = { ...config };
  if (!resolved.apiKey) {
    resolved.apiKey = await getVariable(
      $,
      config.provider === 'cloudflare' ? 'CLOUDFLARE_API_TOKEN' : 'TYPESAFE_API_KEY',
    );
  }
  if (config.provider === 'cloudflare') {
    if (!resolved.cloudflareAccountId && !resolved.baseUrl) {
      resolved.cloudflareAccountId = await getVariable($, 'CLOUDFLARE_ACCOUNT_ID');
    }
    if (!resolved.cloudflareGatewayId) {
      resolved.cloudflareGatewayId = await getVariable($, 'CLOUDFLARE_AI_GATEWAY_ID');
    }
  }
  return resolved;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/**
 * The main loop's own work in the current turn. A call made by a subagent is
 * not counted, and a turn that already delegated is left alone.
 */
export class DelegateTracker {
  private prompt = '';
  private calls: string[] = [];
  private edits = 0;
  private delegated = false;

  constructor(private readonly first: number) {}

  turnStart(prompt: string): void {
    this.prompt = prompt;
    this.calls = [];
    this.edits = 0;
    this.delegated = false;
  }

  /** Records one call of the main loop; true when Jev should be asked now. */
  record(tool: string, input: Record<string, unknown>): boolean {
    if (tool === 'Agent' || tool === 'Task') {
      this.delegated = true;
      return false;
    }
    this.calls.push(callLine(tool, input));
    if (isEditTool(tool)) this.edits += 1;
    return !this.delegated && isCheckpoint(this.calls.length, this.first);
  }

  progress(assistantMessages: readonly string[]): TurnProgress {
    return { prompt: this.prompt, assistantMessages, calls: [...this.calls], edits: this.edits };
  }
}

/** What the assistant said since the user's last typed message. */
export function assistantMessagesOfTurn(messages: readonly SessionMessage[]): string[] {
  let start = 0;
  messages.forEach((message, index) => {
    if (
      message.role === 'user' &&
      message.text.trim().length > 0 &&
      (message.toolResults ?? []).length === 0
    ) {
      start = index + 1;
    }
  });
  return messages
    .slice(start)
    .filter((message) => message.role === 'assistant' && message.text.trim().length > 0)
    .map((message) => message.text);
}

/** Asks Jev about the turn so far; the nudge is set when the rest should be handed over. */
export async function delegateCheck(
  progress: TurnProgress,
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<{ verdict: DelegateVerdict; nudge?: string }> {
  if (!config.apiKey) throw new Error(`${apiKeyVariable(config.provider)} is not configured`);
  const { answers } = await jevAsker(fetchFn, config.apiKey, config).ask(
    delegateState(progress),
    DELEGATE_QUESTIONS,
  );
  const verdict = delegateVerdict(answers);
  return verdict.delegable
    ? { verdict, nudge: delegateNudge(progress, config.delegateModel) }
    : { verdict };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  if (configured.delegateAfterCalls > 0) {
    const tracker = new DelegateTracker(configured.delegateAfterCalls);

    on('turn.start', ($, event, next) => {
      tracker.turnStart(event.text);
      return next(event);
    });

    on('tool.call', async ($, event, next) => {
      const { tool, tool_use_id: _id, agentId, consent: _consent, ...input } = event as {
        tool: string;
        tool_use_id?: string;
        agentId?: string;
        consent?: string;
      } & Record<string, unknown>;
      const due = agentId === undefined && tracker.record(tool, input);
      const result = await next(event);
      if (!due || result.deny !== undefined) return result;
      try {
        const config = await resolveCredentials($, configured);
        const progress = tracker.progress(assistantMessagesOfTurn(await $.session.messages()));
        const { verdict, nudge } = await delegateCheck(progress, config, async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        });
        if (!nudge) return result;
        $.ui.log(
          `fast-jev-compaction: delegate nudge at ${progress.calls.length} calls (plan ${verdict.plan.toFixed(2)}, execution ${verdict.execution.toFixed(2)})`,
        );
        return { ...result, context: [...(result.context ?? []), nudge] };
      } catch (error) {
        $.ui.log(
          `fast-jev-compaction: delegate check skipped (${error instanceof Error ? error.message : String(error)})`,
        );
        return result;
      }
    });
  }

  on('session.compact', async ($, event, next) => {
    try {
      const config = await resolveCredentials($, configured);
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      if (config.logDecisions) for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
