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
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
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
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
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
  minReductionRatio: number;
  model: string;
};

/** The shape of `$.fs.read`, so the log can be written without an engine. */
export type HookFsRead = (path: string) => Promise<string>;
/** The shape of `$.fs.write`, so the log can be written without an engine. */
export type HookFsWrite = (path: string, text: string) => Promise<void>;

/** NDJSON log of every time a hook actually intercepted an event, one line per event. */
export const HOOK_LOG_PATH = '.reflex/hook.log';

/**
 * Appends one NDJSON line to `HOOK_LOG_PATH`, so whether `session.compact` /
 * `turn.complete` actually fired can be checked after the fact instead of
 * only through the ephemeral `$.ui.log`/`$.ui.toast` notices. Best-effort:
 * a logging failure (missing file, read-only filesystem, ...) is swallowed so
 * it never breaks the hook it is instrumenting.
 */
export async function appendHookLog(
  read: HookFsRead,
  write: HookFsWrite,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    let existing = '';
    try {
      existing = await read(HOOK_LOG_PATH);
    } catch {
      existing = '';
    }
    await write(HOOK_LOG_PATH, `${existing}${line}\n`);
  } catch {
    // best-effort: logging must never break compaction
  }
}

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`, talking to the local reflex-serve daemon. */
export function jevAsker(fetchFn: HookFetch, apiKey: string | undefined, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
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

/** Runs the library over a session transcript against the local reflex-serve daemon. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model),
    config,
  );
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

/** `$.session.usage()`'s context reading, best-effort: never throws, absent on any failure. */
async function sessionContextUsage($: {
  session: { usage: () => Promise<{ context: { tokens?: number; percent?: number } }> };
}): Promise<{ tokens?: number; percent?: number } | undefined> {
  try {
    const { context } = await $.session.usage();
    return { tokens: context.tokens, percent: context.percent };
  } catch {
    return undefined;
  }
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('REFLEX_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['REFLEX_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
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

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.start', async ($, event, next) => {
    await appendHookLog(
      (p) => $.fs.read(p),
      (p, t) => $.fs.write(p, t),
      {
        event: 'session.start',
        cwd: event.cwd,
        surface: event.surface,
        isInteractive: event.isInteractive,
      },
    );
    return next(event);
  });

  on('session.compact', async ($, event, next) => {
    const sessionId = await $.session.id().catch(() => undefined);
    // Read before any compaction work: the hook only returns replacement messages,
    // the host swaps them in after we return, so this is the last point at which
    // "before" and "after" would actually differ.
    const contextBefore = await sessionContextUsage($);
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const ratio = reductionRatio(result);
      if (ratio < config.minReductionRatio) {
        await appendHookLog(
          (p) => $.fs.read(p),
          (p, t) => $.fs.write(p, t),
          {
            event: 'session.compact',
            sessionId,
            verdict: 'fallback_low_reduction',
            reductionRatio: ratio,
            minReductionRatio: config.minReductionRatio,
            messagesBefore: event.messages.length,
            decisions: result.decisions
              .filter((d) => d.reason !== 'pinned')
              .map((d) => ({
                id: d.id,
                tool: d.tool,
                action: d.action,
                keepCall: d.keepCall,
                keepResult: d.keepResult,
              })),
          },
        );
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      await appendHookLog(
        (p) => $.fs.read(p),
        (p, t) => $.fs.write(p, t),
        {
          event: 'session.compact',
          sessionId,
          verdict: 'compacted',
          reductionRatio: ratio,
          messagesBefore: event.messages.length,
          messagesAfter: messages.length,
          contextPercentBefore: contextBefore?.percent,
          contextTokensBefore: contextBefore?.tokens,
          decisions: result.decisions
            .filter((d) => d.reason !== 'pinned')
            .map((d) => ({
              id: d.id,
              tool: d.tool,
              action: d.action,
              keepCall: d.keepCall,
              keepResult: d.keepResult,
            })),
        },
      );
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      await appendHookLog(
        (p) => $.fs.read(p),
        (p, t) => $.fs.write(p, t),
        {
          event: 'session.compact',
          sessionId,
          verdict: 'fallback_error',
          error: error instanceof Error ? error.message : String(error),
        },
      );
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    const sessionId = await $.session.id().catch(() => undefined);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await appendHookLog(
        (p) => $.fs.read(p),
        (p, t) => $.fs.write(p, t),
        {
          event: 'turn.complete',
          sessionId,
          verdict: 'triggered_compact',
          contextPercent: context.percent,
          compactAtPercent: configured.compactAtPercent,
        },
      );
      await $.session.compact();
      // $.session.compact() resolves once the host has applied whatever the
      // session.compact hook returned, so this is the actual post-compaction
      // reading -- unlike anything read from inside that hook, which runs
      // before the swap.
      const after = await sessionContextUsage($);
      await appendHookLog(
        (p) => $.fs.read(p),
        (p, t) => $.fs.write(p, t),
        {
          event: 'turn.complete',
          sessionId,
          verdict: 'compact_finished',
          contextPercentAfter: after?.percent,
          contextTokensAfter: after?.tokens,
        },
      );
    } catch (error) {
      await appendHookLog(
        (p) => $.fs.read(p),
        (p, t) => $.fs.write(p, t),
        {
          event: 'turn.complete',
          sessionId,
          verdict: 'compact_failed',
          error: error instanceof Error ? error.message : String(error),
        },
      );
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
