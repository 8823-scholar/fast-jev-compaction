import {
  apiKeyVariable,
  buildJevRequest,
  parseJevResponse,
  type JevProvider,
} from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `TYPESAFE_API_KEY`, or `CLOUDFLARE_API_TOKEN` for the cloudflare provider. */
  apiKey?: string;
  /** Defaults to `typesafe`. */
  provider?: JevProvider;
  /** Defaults to `jev-latest`; ignored for `cloudflare`. */
  model?: string;
  /** Defaults to the provider's endpoint. */
  baseUrl?: string;
  /** Defaults to `CLOUDFLARE_ACCOUNT_ID`; only used by the cloudflare provider. */
  cloudflareAccountId?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly provider: JevProvider;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly cloudflareAccountId: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.provider = options.provider ?? 'typesafe';
    this.apiKey = options.apiKey ?? process.env[apiKeyVariable(this.provider)] ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.cloudflareAccountId =
      options.cloudflareAccountId ??
      (this.provider === 'cloudflare' ? process.env.CLOUDFLARE_ACCOUNT_ID : undefined);
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(`${apiKeyVariable(this.provider)} is not configured`);
    const request = buildJevRequest(
      {
        apiKey: this.apiKey,
        provider: this.provider,
        model: this.model,
        baseUrl: this.baseUrl,
        cloudflareAccountId: this.cloudflareAccountId,
      },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
