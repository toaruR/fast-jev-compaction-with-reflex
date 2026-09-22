import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Only needed for a `reflex-serve` daemon started with `--api-key`/`REFLEX_API_KEY`. */
  apiKey?: string;
  /** Defaults to `Qwen/Qwen3.5-4B`. */
  model?: string;
  /** Defaults to the local `reflex-serve` endpoint (`http://127.0.0.1:8008/v1/systemone`). */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks a local reflex-serve daemon over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.REFLEX_API_KEY ?? undefined;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
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
