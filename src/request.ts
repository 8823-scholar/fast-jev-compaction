import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export const CLOUDFLARE_MODEL = 'typesafe/jev';

/**
 * Where Jev is served from. `typesafe` is the System One API; `cloudflare` is
 * Cloudflare's `/ai/run` endpoint with the `typesafe/jev` model, reached with a
 * Cloudflare API token and billed through AI Gateway (credits or BYOK).
 */
export type JevProvider = 'typesafe' | 'cloudflare';

/** The environment variable holding the provider's credential. */
export function apiKeyVariable(provider: JevProvider): string {
  return provider === 'cloudflare' ? 'CLOUDFLARE_API_TOKEN' : 'TYPESAFE_API_KEY';
}

export interface JevRequestParams {
  apiKey: string;
  /** Default `typesafe`. */
  provider?: JevProvider;
  /** Ignored for `cloudflare`, which always names `typesafe/jev`. */
  model?: string;
  /** Overrides the endpoint of either provider (for example an AI Gateway URL). */
  baseUrl?: string;
  /** Required for `cloudflare` unless `baseUrl` is set. */
  cloudflareAccountId?: string;
  /** Routes `cloudflare` requests through this AI Gateway (`cf-aig-gateway-id`). */
  cloudflareGatewayId?: string;
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export function cloudflareRunUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
}

function requestUrl(params: JevRequestParams): string {
  if (params.baseUrl) return params.baseUrl;
  if (params.provider === 'cloudflare') {
    if (!params.cloudflareAccountId) {
      throw new Error('cloudflareAccountId or baseUrl is required for the cloudflare provider');
    }
    return cloudflareRunUrl(params.cloudflareAccountId);
  }
  return SYSTEM_ONE_URL;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: JevRequestParams,
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const cloudflare = params.provider === 'cloudflare';
  const body = cloudflare
    ? { model: CLOUDFLARE_MODEL, input: { state, questions } }
    : { model: params.model ?? DEFAULT_MODEL, state, questions };
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.apiKey}`,
    'content-type': 'application/json',
  };
  if (cloudflare && params.cloudflareGatewayId) {
    headers['cf-aig-gateway-id'] = params.cloudflareGatewayId;
  }
  return {
    url: requestUrl(params),
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };
}

function hasAnswers(value: unknown): value is JevResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'answers' in value &&
    value.answers !== null &&
    typeof value.answers === 'object'
  );
}

/**
 * The `answers` object inside a response, looking through `result` envelopes.
 * Cloudflare's `/ai/run` returns `{ result: { state, result: <model output> } }`.
 */
function unwrapAnswers(value: unknown, depth = 0): JevResponse | undefined {
  if (hasAnswers(value)) return value;
  if (depth < 2 && value !== null && typeof value === 'object' && 'result' in value) {
    return unwrapAnswers(value.result, depth + 1);
  }
  return undefined;
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  const response = unwrapAnswers(parsed);
  if (!response) throw new Error('Jev response is missing answers');
  return response;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
