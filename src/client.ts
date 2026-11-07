// WorkvivoClient — every call to Workvivo's internal `/api/*` routes.
//
// Workvivo is a Laravel app behind SAML SSO. Its `/api/*` routes authenticate
// with the browser's session cookies (laravel_token / workvivo_session) AND a
// CSRF header: the per-session token the SPA shell embeds as
// `<meta name="csrf_token" content="…">`, sent as `X-CSRF-Token` alongside
// `X-Requested-With: XMLHttpRequest`. Without the header EVERY call — GETs
// included — answers `401 {"message":"Unauthenticated."}` (verified live).
//
// The token comes from the SPA shell, which is ~600 KB on every route, so it
// is read ONCE per process (single-flight) and re-read only when a call comes
// back 401/419 — a rotated session — before the call is retried exactly once.
// The `XSRF-TOKEN` cookie is NOT a substitute: sent as `X-XSRF-TOKEN` it is
// refused (verified live), so there is no cheaper source.
//
// Error mapping lives here, not in the transport: a bounce to the SSO host or
// to /login, a missing token, or a second 401 is a signed-out browser; 403 is
// a permission refusal; other non-2xx statuses surface Workvivo's own message.

import {
  McpToolError,
  messageOf,
  parseJsonBody,
  splitHost,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import { isHostedEnv } from '@chrischall/mcp-utils/export';
import {
  adoptBrowserDownload,
  readDownloadPolicy,
  saveFromSignedUrl,
  type DownloadOutcome,
  type DownloadPolicy,
} from './download.js';
import { stat } from 'node:fs/promises';
import type { BridgeProbeResult, BridgeStatus, FetchResult, WorkvivoTransport } from './transport.js';

/** Where a page lives: a space, or a global page collection ("page group"). */
export type PageScope = { space_id: number } | { page_group_id: number };

/** A downloadable Workvivo document: `/document/link/<id>` or `/file/<id>`. */
export type DocumentRef = { kind: 'document' | 'file'; id: number };

type Rec = Record<string, unknown>;

/** Depth-first search of a pages-v2 tree for a page id. */
function findInTree(nodes: unknown, id: number): Rec | undefined {
  if (!Array.isArray(nodes)) return undefined;
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue;
    const r = n as Rec;
    if (r.id === id) return r;
    const hit = findInTree(r.children, id);
    if (hit) return hit;
  }
  return undefined;
}

const SERVICE = 'Workvivo';

/** Configuration missing or malformed — surfaces on the first tool call. */
export class WorkvivoConfigError extends McpToolError {
  constructor(message: string) {
    super(message, {
      kind: 'no_credential',
      hint: 'Set WORKVIVO_HOST to your organization\'s Workvivo host, e.g. acme.workvivo.us.',
    });
    this.name = 'WorkvivoConfigError';
  }
}

/** The paired browser is not signed in to Workvivo (or the session expired). */
export class WorkvivoSessionError extends McpToolError {
  constructor(host: string, detail: string) {
    const hint =
      `Open https://${host} in the browser paired with ContextMint Bridge, complete your ` +
      'company sign-in (SSO), then retry.';
    super(`Not signed in to Workvivo (${detail}). ${hint}`, { kind: 'session_expired', hint, status: 401 });
    this.name = 'WorkvivoSessionError';
  }
}

/** Workvivo answered with a non-2xx status. */
export class WorkvivoApiError extends McpToolError {
  constructor(message: string, status: number, hint?: string) {
    super(message, { status, kind: 'http', ...(hint ? { hint } : {}) });
    this.name = 'WorkvivoApiError';
  }
}

/**
 * Why a hosted server (mcp-host) refuses to read documents. The signed file
 * URL is on the tenant's file host, which is outside the registration's egress
 * allowlist and too unstable to add, and the bridge's `fetch` verb decodes
 * every body as UTF-8 text (and the file host sends no CORS headers), so the
 * browser cannot hand the bytes over either. The browser `download` verb saves
 * on the user's machine, which the runner cannot read.
 */
export const HOSTED_DOCUMENTS_UNSUPPORTED =
  "Reading Workvivo documents isn't supported on a hosted server yet: the file host is outside this " +
  "server's allowed network hosts, and the browser bridge cannot return file contents. Use a local " +
  'install, or open the document in Workvivo.';

/** The refusal {@link WorkvivoClient.downloadDocument} raises when hosted. */
export class HostedDocumentsError extends McpToolError {
  constructor() {
    super(HOSTED_DOCUMENTS_UNSUPPORTED, {
      kind: 'unknown',
      hint: 'Install workvivo-mcp locally to read documents, or open the document in Workvivo.',
    });
    this.name = 'HostedDocumentsError';
  }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalize WORKVIVO_HOST: accept `acme.workvivo.us`, `https://acme.workvivo.us/`
 * or a pasted page URL; return the bare lowercase hostname. `undefined` in →
 * `undefined` out (unconfigured); anything that is not a hostname throws.
 */
export function normalizeHost(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    if (u.username || u.password || u.port) throw new Error('userinfo/port');
    host = u.hostname;
  } catch {
    throw new WorkvivoConfigError(`WORKVIVO_HOST is not a hostname: ${JSON.stringify(raw)}`);
  }
  if (!HOST_RE.test(host)) {
    throw new WorkvivoConfigError(`WORKVIVO_HOST is not a hostname: ${JSON.stringify(raw)}`);
  }
  return host;
}

/** Pull the session CSRF token out of the SPA shell. */
export function extractCsrfToken(html: string): string | undefined {
  const m =
    /<meta\s+name=["']csrf_token["']\s+content=["']([^"']+)["']/i.exec(html) ??
    /<meta\s+content=["']([^"']+)["']\s+name=["']csrf_token["']/i.exec(html);
  return m?.[1];
}

/** Build `path?query`, dropping undefined/null/'' values. */
export function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

export interface WorkvivoClientOptions {
  transport: WorkvivoTransport;
  host: string | undefined;
  /** A config error found at boot, re-thrown on the first call. */
  configError?: WorkvivoConfigError;
  /** Where/how big/which types of documents to fetch — or the error reading
   *  that config, re-thrown on the first document read. Defaults to the env. */
  downloadPolicy?: DownloadPolicy | Error;
  /** Injectable fetch for the direct file download (tests). */
  fetchImpl?: typeof fetch;
}

export class WorkvivoClient {
  private readonly transport: WorkvivoTransport;
  private readonly hostValue: string | undefined;
  private readonly configError: WorkvivoConfigError | undefined;
  private token: string | undefined;
  private tokenInFlight: Promise<string> | undefined;
  /** Documents saved by this process, so a re-read does not re-download. */
  private readonly downloads = new Map<string, Extract<DownloadOutcome, { kind: 'saved' }>>();
  private readonly downloadPolicy: DownloadPolicy | Error;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: WorkvivoClientOptions) {
    this.transport = opts.transport;
    this.hostValue = opts.host;
    if (opts.downloadPolicy !== undefined) this.downloadPolicy = opts.downloadPolicy;
    else {
      try {
        this.downloadPolicy = readDownloadPolicy();
      } catch (e) {
        this.downloadPolicy = e as Error;
      }
    }
    this.fetchImpl = opts.fetchImpl;
    this.configError =
      opts.configError ??
      (opts.host ? undefined : new WorkvivoConfigError('WORKVIVO_HOST is not set.'));
  }

  /** The configured host, or a placeholder label when unconfigured. */
  get hostLabel(): string {
    return this.hostValue ?? '<WORKVIVO_HOST>';
  }

  /** The configured host; throws the deferred config error when unset. */
  get host(): string {
    if (this.configError) throw this.configError;
    return this.hostValue as string;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /** GET `/api/<path>` and parse JSON. `path` is relative to `/api/`. */
  async get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    return this.call<T>('GET', withQuery(path, query));
  }

  /** POST JSON to `/api/<path>` — used only for read-only endpoints (search). */
  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', path, JSON.stringify(body));
  }

  /** `https://<host>` — the base every relative Workvivo link resolves against. */
  get origin(): string {
    return `https://${this.host}`;
  }

  /** The page tree of a space or a global page collection (`pages-v2`). */
  async getPageTree(scope: PageScope): Promise<Rec> {
    const path = 'space_id' in scope ? `spaces/${scope.space_id}/pages-v2` : `pages-v2/${scope.page_group_id}`;
    return (await this.get<Rec>(path, { include_content: 'false' })) ?? {};
  }

  /**
   * One page with its content. `page` is the page's slug (what Workvivo URLs
   * carry) or its numeric id; an id that is not also a slug is resolved
   * through the tree. Omit it for the scope's landing page.
   */
  async getPage(scope: PageScope, page?: string | number): Promise<Rec> {
    const base = 'space_id' in scope ? `spaces/${scope.space_id}/pages` : `pages/${scope.page_group_id}`;
    const fetchSlug = (slug: string) =>
      this.get<Rec>(slug ? `${base}/${encodeURIComponent(slug)}` : base, { include_content: 'true' });
    if (page === undefined || page === '') return (await fetchSlug('')) ?? {};
    const key = String(page).trim();
    try {
      return (await fetchSlug(key)) ?? {};
    } catch (e) {
      // A numeric page id is not always its slug: look the id up in the tree.
      if (!(e instanceof WorkvivoApiError && e.status === 404 && /^\d+$/.test(key))) throw e;
      const tree = await this.getPageTree(scope);
      const node = findInTree(tree.pages, Number(key));
      const slug = typeof node?.slug === 'string' ? node.slug : undefined;
      if (!slug || slug === key) throw e;
      return (await fetchSlug(slug)) ?? {};
    }
  }

  /** Is `host` this tenant's own domain (e.g. `attachments.workvivo.us` for `acme.workvivo.us`)? */
  isTenantHost(host: string): boolean {
    const apex = splitHost(this.host).domain;
    return host === apex || host.endsWith(`.${apex}`);
  }

  /**
   * Fetch a linked document into the configured download directory, applying
   * the type and size rules (src/download.ts). Preferred: capture the signed
   * redirect target through the browser and fetch it here, checking type and
   * size before any body is read. Fallback (no capture permission, no
   * webRequest): the browser downloads it, then the same rules run on the file
   * and it is moved into place. Saved files are reused for the process's life.
   *
   * Hosted (`isHostedEnv`), it refuses before any capture or request: see
   * {@link HOSTED_DOCUMENTS_UNSUPPORTED}.
   */
  async downloadDocument(ref: DocumentRef): Promise<DownloadOutcome> {
    if (isHostedEnv()) throw new HostedDocumentsError();
    const policy = this.downloadPolicy;
    if (policy instanceof Error) throw policy;
    const path = `/${ref.kind === 'document' ? 'document/link' : 'file'}/${ref.id}`;
    const url = `${this.origin}${path}`;
    const cached = this.downloads.get(url);
    if (cached) {
      try {
        if ((await stat(cached.path)).isFile()) return cached;
      } catch {
        // deleted since — fetch again
      }
    }
    let outcome: DownloadOutcome;
    try {
      const signed = await this.transport.captureSignedUrl(path);
      // Landing on this tenant's own /saml or /login means signed out. Any
      // other non-file host is refused by saveFromSignedUrl, which falls back
      // to the browser download below.
      const su = new URL(signed);
      if (su.hostname === this.host && /^\/(saml|login)(\/|$)/.test(su.pathname)) {
        throw new WorkvivoSessionError(this.host, 'the document link redirected to sign-in');
      }
      outcome = await saveFromSignedUrl(signed, policy, (h) => this.isTenantHost(h), this.fetchImpl);
    } catch (e) {
      if (e instanceof WorkvivoSessionError) throw e;
      console.error(`[workvivo-mcp] direct document fetch failed (${messageOf(e)}); falling back to a browser download`);
      const res = await this.transport.download({ url, timeoutMs: 120_000 });
      // A signed-out browser downloads the sign-in page instead of the file.
      if ((res.mime ?? '').startsWith('text/html') && res.finalUrl && this.isSignInBounce({ status: 200, body: '', url: res.finalUrl })) {
        throw new WorkvivoSessionError(this.host, 'the document link redirected to sign-in');
      }
      outcome = await adoptBrowserDownload(res, policy);
    }
    if (outcome.kind === 'saved') this.downloads.set(url, outcome);
    return outcome;
  }

  private isSignInBounce(res: FetchResult): boolean {
    if (!res.url) return false;
    let u: URL;
    try {
      u = new URL(res.url);
    } catch {
      return false;
    }
    if (u.hostname !== this.hostValue) return true;
    return /^\/(saml|login)(\/|$)/.test(u.pathname);
  }

  /** The session CSRF token, read from the SPA shell once (single-flight). */
  private async csrf(): Promise<string> {
    if (this.token) return this.token;
    if (!this.tokenInFlight) {
      this.tokenInFlight = (async () => {
        const host = this.host;
        const res = await this.transport.fetch({ path: '/', method: 'GET' });
        if (this.isSignInBounce(res)) throw new WorkvivoSessionError(host, 'redirected to sign-in');
        if (res.status >= 400) {
          throw new WorkvivoApiError(
            `Workvivo home page answered HTTP ${res.status} while reading the session token.`,
            res.status,
          );
        }
        const token = extractCsrfToken(res.body);
        if (!token) throw new WorkvivoSessionError(host, 'no session token on the home page');
        this.token = token;
        return token;
      })().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private async call<T>(method: 'GET' | 'POST', apiPath: string, body?: string): Promise<T> {
    const host = this.host;
    const rel = apiPath.replace(/^\/+/, '').replace(/^api\//, '');
    const path = `/api/${rel}`;
    for (let attempt = 1; ; attempt++) {
      const token = await this.csrf();
      const res = await this.transport.fetch({
        path,
        method,
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
          'X-CSRF-Token': token,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body, retryOnTimeout: true } : {}),
      });
      if (this.isSignInBounce(res)) {
        this.token = undefined;
        throw new WorkvivoSessionError(host, 'redirected to sign-in');
      }
      if (res.status === 401 || res.status === 419) {
        this.token = undefined;
        if (attempt === 1) continue;
        throw new WorkvivoSessionError(host, `${method} ${path} answered ${res.status} with a fresh token`);
      }
      if (res.status < 200 || res.status >= 300) throw this.httpError(method, path, res);
      if (!res.body.trim()) return null as T;
      return parseJsonBody<T>(res.body, { service: SERVICE, method, path, status: res.status });
    }
  }

  private httpError(method: string, path: string, res: FetchResult): WorkvivoApiError {
    let upstream = '';
    try {
      const j = JSON.parse(res.body) as { message?: unknown };
      if (typeof j?.message === 'string') upstream = j.message.trim();
    } catch {
      // not JSON — leave upstream empty rather than quoting an HTML page
    }
    const said = upstream ? `: ${truncateErrorMessage(upstream, 300)}` : '';
    if (res.status === 403) {
      return new WorkvivoApiError(
        `Workvivo refused ${method} ${path} (403)${said}`,
        403,
        'Your Workvivo account is not permitted to read this — e.g. a space\'s member list is visible only to its owners.',
      );
    }
    if (res.status === 404) {
      return new WorkvivoApiError(`Workvivo has no ${path} (404)${said}`, 404, 'Check the id — find it with a list or search tool first.');
    }
    if (res.status >= 500) {
      return new WorkvivoApiError(
        `Workvivo ${method} ${path} failed with HTTP ${res.status}${said}`,
        res.status,
        'Workvivo answers 500 for some ids and unsupported filters as well as real outages; check the id, then retry later.',
      );
    }
    return new WorkvivoApiError(`Workvivo ${method} ${path} failed with HTTP ${res.status}${said}`, res.status);
  }
}
