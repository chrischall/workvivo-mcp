// Adapter that lets @fetchproxy/server satisfy WorkvivoTransport.
//
// The verb surface (fetch / runProbe / status / start / close) is the shared
// `createFetchproxyTransport` from @chrischall/mcp-utils/fetchproxy. The bridge
// target is derived from the configured host: `acme.workvivo.us` maps to
// domain `workvivo.us` + subdomain `acme`, so requests route to that tab.

import { McpToolError, messageOf, splitHost } from '@chrischall/mcp-utils';
import {
  classifyFetchError,
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeProbeResult,
  BridgeStatus,
  DownloadResult,
  FetchInit,
  FetchResult,
  WorkvivoTransport,
} from './transport.js';

export const DEFAULT_PORT = 37_149;

/**
 * A pairing approved before `download` was declared keeps its old grant: the
 * extension refuses the verb (`capability "download" not granted`) rather
 * than re-prompting. Name the remedy; pass every other error through.
 */
export function mapDownloadError(e: unknown): unknown {
  if (classifyFetchError(messageOf(e)) !== 'capability_denied') return e;
  return new McpToolError(
    'ContextMint Bridge has not granted workvivo-mcp permission to read documents (the pairing predates it).',
    {
      kind: 'credential_rejected',
      cause: e,
      hint:
        'Open the ContextMint Bridge popup, remove workvivo-mcp, then call workvivo_healthcheck and approve the new ' +
        'pair code — the new pairing includes the download permission.',
    },
  );
}

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
  private readonly host: string | undefined;

  constructor(opts: FetchproxyTransportOptions) {
    this.host = opts.host;
    const { domain, subdomain } = splitHost(opts.host ?? 'workvivo.com');
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: opts.port ?? DEFAULT_PORT,
      serverName: 'workvivo-mcp',
      version: opts.version,
      logListening: true,
      domains: [domain],
      // Linked documents (/document/link/<id>) 302 to a signed file host a page
      // fetch cannot follow. `capture_redirect` reads that signed URL so the
      // server can check and fetch the file itself; `download` is the fallback
      // (the browser saves it). Declared at pair time — an existing pairing
      // without them is REFUSED (not re-prompted) until re-approved.
      capabilities: ['fetch', 'capture_redirect', 'download'],
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

  async download(opts: { url: string; timeoutMs?: number }): Promise<DownloadResult> {
    const started = Date.now();
    let res: DownloadResult;
    try {
      res = await this.inner.server.download({ url: opts.url, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    } catch (e) {
      throw mapDownloadError(e);
    }
    log('download', { url: opts.url, bytes: res.bytes, mime: res.mime, ms: Date.now() - started });
    return res;
  }

  async captureSignedUrl(path: string): Promise<string> {
    if (!this.host) throw new Error('WORKVIVO_HOST is not set.');
    // Arm the one-shot redirect listener, then make the browser request the
    // link. The page fetch itself fails (the file host sends no CORS headers)
    // — that is expected; the listener has the redirect target by then.
    const captured = this.inner.server.captureRedirect({ host: this.host, path, timeoutMs: 20_000 });
    captured.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    this.inner.fetch({ method: 'GET', path }).catch(() => undefined);
    try {
      const url = await captured;
      log('captureSignedUrl', { path, host: new URL(url).host });
      return url;
    } catch (e) {
      throw mapDownloadError(e);
    }
  }

  async runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
