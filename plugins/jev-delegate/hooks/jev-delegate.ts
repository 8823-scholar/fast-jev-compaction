import type { On, PluginOptions, Register, SessionMessage } from 'claude-code';

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
} from '../src/jev.js';

const DEFAULTS = {
  afterCalls: 12,
  delegateModel: 'opus',
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

/** The shape of `$.http.fetch`, so the check can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type DelegateConfig = {
  apiKey?: string;
  /**
   * Own tool calls in a turn after which Jev is first asked whether the rest
   * should go to a subagent; 0 never asks.
   */
  afterCalls: number;
  /** The model the nudge names for the subagent. */
  delegateModel: string;
  model: string;
  provider: JevProvider;
  baseUrl?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
};

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionProvider(options: PluginOptions): JevProvider {
  const value = optionString(options, 'provider');
  if (value === undefined) return DEFAULTS.provider;
  if (value === 'typesafe' || value === 'cloudflare') return value;
  throw new Error(`unknown provider "${value}" (expected typesafe or cloudflare)`);
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveDelegateConfig(options: PluginOptions): DelegateConfig {
  const afterCalls = options['afterCalls'];
  const config: DelegateConfig = {
    afterCalls:
      typeof afterCalls === 'number' && Number.isFinite(afterCalls)
        ? Math.max(0, Math.floor(afterCalls))
        : DEFAULTS.afterCalls,
    delegateModel: optionString(options, 'delegateModel') ?? DEFAULTS.delegateModel,
    model: optionString(options, 'model') ?? DEFAULTS.model,
    provider: optionProvider(options),
  };
  for (const key of ['apiKey', 'baseUrl', 'cloudflareAccountId', 'cloudflareGatewayId'] as const) {
    const value = optionString(options, key);
    if (value) config[key] = value;
  }
  return config;
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
export async function resolveCredentials($: HookEnv, config: DelegateConfig): Promise<DelegateConfig> {
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
  config: DelegateConfig,
  fetchFn: HookFetch,
): Promise<{ verdict: DelegateVerdict; nudge?: string }> {
  if (!config.apiKey) throw new Error(`${apiKeyVariable(config.provider)} is not configured`);
  const request = buildJevRequest(
    { ...config, apiKey: config.apiKey },
    delegateState(progress),
    DELEGATE_QUESTIONS,
  );
  const response = await fetchFn(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const { answers } = parseJevResponse(response.status, response.ok, response.text);
  const verdict = delegateVerdict(answers);
  return verdict.delegable
    ? { verdict, nudge: delegateNudge(progress, config.delegateModel) }
    : { verdict };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveDelegateConfig(options);
  if (configured.afterCalls === 0) return;
  const tracker = new DelegateTracker(configured.afterCalls);

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
        `jev-delegate: nudge at ${progress.calls.length} calls (plan ${verdict.plan.toFixed(2)}, execution ${verdict.execution.toFixed(2)})`,
      );
      return { ...result, context: [...(result.context ?? []), nudge] };
    } catch (error) {
      $.ui.log(
        `jev-delegate: check skipped (${error instanceof Error ? error.message : String(error)})`,
      );
      return result;
    }
  });
};
