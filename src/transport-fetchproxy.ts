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
import { FetchproxyExtensionUpdateRequiredError, FetchproxyResponseTooLargeError } from '@fetchproxy/server';
import {
  BridgeResponseTooLargeError,
  ExtensionUpdateRequiredError,
  type BridgeProbeResult,
  type BridgeStatus,
  type BytesResult,
  type DownloadResult,
  type FetchInit,
  type FetchResult,
  type WorkvivoTransport,
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

/** fetchproxy's error class, matched by class or (across bundled copies) by name. */
function isNamed<T>(e: unknown, cls: abstract new (...args: never[]) => T, name: string): e is T {
  return e instanceof cls || (e instanceof Error && e.name === name);
}

/**
 * Map a failed binary fetch (`getBytes`) onto what the client can act on:
 * an extension too old for binary fetch → update it; a body over the bridge's
 * cap → a skip; a file host that redirected outside the paired domains → a
 * clear refusal. A capability refusal keeps {@link mapDownloadError}'s remedy.
 */
export function mapBytesError(e: unknown, domain: string): unknown {
  if (isNamed(e, FetchproxyExtensionUpdateRequiredError, 'FetchproxyExtensionUpdateRequiredError')) {
    return new ExtensionUpdateRequiredError(e);
  }
  if (isNamed(e, FetchproxyResponseTooLargeError, 'FetchproxyResponseTooLargeError')) {
    return new BridgeResponseTooLargeError({ limitBytes: e.limitBytes, declaredBytes: e.declaredBytes }, e);
  }
  const msg = messageOf(e);
  if (classifyFetchError(msg) === 'domain_denied' || /outside declared domains/.test(msg)) {
    return new McpToolError(
      `The Workvivo file host redirected outside ${domain}, the only site workvivo-mcp's ContextMint Bridge pairing covers, so the document was not read.`,
      { kind: 'http', cause: e, hint: 'Open the document in Workvivo instead.' },
    );
  }
  return mapDownloadError(e);
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
  private readonly domain: string;

  constructor(opts: FetchproxyTransportOptions) {
    this.host = opts.host;
    const { domain, subdomain } = splitHost(opts.host ?? 'workvivo.com');
    this.domain = domain;
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: opts.port ?? DEFAULT_PORT,
      serverName: 'workvivo-mcp',
      version: opts.version,
      logListening: true,
      // The apex, not the tenant host: it also covers the tenant's file host
      // (`attachments.<apex>`), which hosted document reads fetch through the
      // bridge (`fetchBytes`). Keep this set unchanged — the extension compares
      // it as a SET, and any change sends every existing pairing back through a
      // re-pair prompt.
      domains: [domain],
      // Linked documents (/document/link/<id>) 302 to a signed file host a page
      // fetch cannot follow. `capture_redirect` reads that signed URL so the
      // server can check and fetch the file itself; `download` is the fallback
      // (the browser saves it). Declared at pair time — an existing pairing
      // without them is REFUSED (not re-prompted) until re-approved. Binary
      // fetch needs no capability of its own: it is `fetch` with a byte body.
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

  async fetchBytes(url: string): Promise<BytesResult> {
    const started = Date.now();
    let res: BytesResult;
    try {
      // From the extension's background worker (no tab, so the file host's
      // missing CORS headers do not matter). The signed URL is its own
      // credential, so the page's cookies are not sent along.
      res = await this.inner.server.getBytes(url, { credentials: 'omit' });
    } catch (e) {
      throw mapBytesError(e, this.domain);
    }
    log('fetchBytes', { host: new URL(url).host, status: res.status, bytes: res.bytes.length, ms: Date.now() - started });
    return { status: res.status, url: res.url, headers: res.headers, bytes: res.bytes };
  }

  async runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
