import { createTestHarness } from '@chrischall/mcp-utils/test';
import { WorkvivoClient } from '../src/client.js';
import type { BridgeProbeResult, BridgeStatus, FetchInit, FetchResult, WorkvivoTransport } from '../src/transport.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerFeedTools } from '../src/tools/feed.js';
import { registerNewsTools } from '../src/tools/news.js';
import { registerPostTools } from '../src/tools/posts.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerPeopleTools } from '../src/tools/people.js';
import { registerSpaceTools } from '../src/tools/spaces.js';
import { registerNotificationTools } from '../src/tools/notifications.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerQuestionTools } from '../src/tools/questions.js';
import { registerRawTools } from '../src/tools/raw.js';

export const HOST = 'acme.workvivo.us';
export const TOKEN = 'csrf-token-synthetic';
export const SHELL = `<html><head><meta name="csrf_token" content="${TOKEN}"></head><body></body></html>`;

type Handler = (init: FetchInit) => Partial<FetchResult> | unknown;

/**
 * A scripted transport. `routes` maps a path (exact, or a path without its
 * query) to either a JSON-able body or a function returning a partial
 * FetchResult. `/` answers the SPA shell unless overridden. Every request is
 * recorded in `calls`.
 */
export class StubTransport implements WorkvivoTransport {
  calls: FetchInit[] = [];
  constructor(public routes: Record<string, unknown | Handler> = {}) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
  async runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult> {
    await fetchFn(probePath);
    return { ok: true } as unknown as BridgeProbeResult;
  }
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    const bare = init.path.split('?')[0]!;
    const route = init.path in this.routes ? this.routes[init.path] : this.routes[bare];
    const url = `https://${HOST}${init.path}`;
    if (route === undefined) {
      if (init.path === '/') return { status: 200, body: SHELL, url };
      return { status: 404, body: '{"message":""}', url };
    }
    const r = typeof route === 'function' ? (route as Handler)(init) : route;
    // A raw response is an object whose keys are ONLY status/body/url — a
    // Workvivo record can itself have a `body` field (question posts do).
    const keys = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : [];
    if (keys.length > 0 && keys.every((k) => k === 'status' || k === 'body' || k === 'url')) {
      const fr = r as Partial<FetchResult>;
      return { status: fr.status ?? 200, body: fr.body ?? '', url: fr.url ?? url };
    }
    return { status: 200, body: typeof r === 'string' ? r : JSON.stringify(r), url };
  }
  /** API calls only (the SPA-shell token fetches filtered out). */
  get apiCalls(): FetchInit[] {
    return this.calls.filter((c) => c.path.startsWith('/api/'));
  }
}

export function makeClient(routes: Record<string, unknown> = {}) {
  const transport = new StubTransport(routes);
  const client = new WorkvivoClient({ transport, host: HOST });
  return { transport, client };
}

export const ALL_REGISTRARS = [
  registerHealthcheckTools,
  registerFeedTools,
  registerNewsTools,
  registerPostTools,
  registerEventTools,
  registerPeopleTools,
  registerSpaceTools,
  registerNotificationTools,
  registerSearchTools,
  registerQuestionTools,
  registerRawTools,
];

export async function harnessFor(routes: Record<string, unknown> = {}) {
  const { transport, client } = makeClient(routes);
  const harness = await createTestHarness((s) => {
    for (const r of ALL_REGISTRARS) r(s, client);
  });
  return { transport, client, harness };
}

/** The text payload of a tool result, parsed as JSON. */
export function payload(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

export function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}
