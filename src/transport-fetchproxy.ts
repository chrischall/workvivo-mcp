// Adapter that lets @fetchproxy/server satisfy WorkvivoTransport.
//
// The verb surface (fetch / runProbe / status / start / close) is the shared
// `createFetchproxyTransport` from @chrischall/mcp-utils/fetchproxy. The bridge
// target is derived from the configured host: `acme.workvivo.us` maps to
// domain `workvivo.us` + subdomain `acme`, so requests route to that tab.

import { splitHost } from '@chrischall/mcp-utils';
import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchInit,
  FetchResult,
  WorkvivoTransport,
} from './transport.js';

export const DEFAULT_PORT = 37_149;

const DEBUG = process.env.WORKVIVO_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[workvivo-mcp:bridge]', ...args);
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** Workvivo host, e.g. `acme.workvivo.us`. Undefined when unconfigured —
   *  the transport is then built against a placeholder and never used, since
   *  the client refuses every call with its config error first. */
  host: string | undefined;
  version: string;
  /** Per-request timeout in ms. Omit for the server's default. */
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements WorkvivoTransport {
  private readonly inner: FetchproxyVerbTransport;

  constructor(opts: FetchproxyTransportOptions) {
    const { domain, subdomain } = splitHost(opts.host ?? 'workvivo.com');
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: opts.port ?? DEFAULT_PORT,
      serverName: 'workvivo-mcp',
      version: opts.version,
      logListening: true,
      domains: [domain],
      ...(subdomain ? { defaultSubdomain: subdomain } : {}),
      ...(opts.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: opts.fetchTimeoutMs } : {}),
    });
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  status(): BridgeStatus {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const started = Date.now();
    const res = await this.inner.fetch({
      method: init.method,
      path: init.path,
      headers: init.headers,
      body: init.body,
      ...(init.retryOnTimeout !== undefined ? { retryOnTimeout: init.retryOnTimeout } : {}),
    });
    log('fetch', { method: init.method, path: init.path, status: res.status, ms: Date.now() - started, bytes: res.body.length });
    return { status: res.status, body: res.body, url: res.url };
  }

  async runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
