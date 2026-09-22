import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/** Local `reflex-serve` daemon (`reflex/`), a drop-in replacement for Jev's hosted endpoint. */
export const SYSTEM_ONE_URL = 'http://127.0.0.1:8008/v1/systemone';
export const DEFAULT_MODEL = 'Qwen/Qwen3.5-4B';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    /** Only reflex-serve daemons started with `--api-key`/`REFLEX_API_KEY` need this. */
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a reflex response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`reflex request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('reflex returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('reflex response is missing answers');
  }
  return parsed as JevResponse;
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
    throw new Error(`Invalid reflex answer for ${name}`);
  }
  return answer.noul;
}
