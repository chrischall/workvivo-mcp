// Transport-agnostic interface for the bridge that relays Workvivo fetches
// through the user's real, signed-in browser session.
//
// Workvivo tenants sit behind corporate SSO (SAML), so there is no
// server-side login: every request rides the user's already-authenticated
// `<org>.workvivo.<tld>` tab. The default implementation in
// src/transport-fetchproxy.ts wraps @fetchproxy/server's FetchproxyServer and
// the ContextMint Bridge browser extension.
//
// WorkvivoClient (src/client.ts) accepts any WorkvivoTransport. Error mapping
// (non-2xx, sign-in bounce, JSON parse, the CSRF handshake) lives on the
// client — every implementation only round-trips a request.

export interface FetchInit {
  /** Path-and-query relative to the Workvivo host, e.g. `/api/activity`. */
  path: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Serialized request body (JSON callers stringify first). */
  body?: string;
  /** Re-send once if the bridge times out. Omit for fetchproxy's default
   *  (GETs retry, POSTs are sent once). This server's only POST is the
   *  read-only federated search, which sets it to `true`. */
  retryOnTimeout?: boolean;
}

export interface FetchResult {
  status: number;
  /** Response body as a string. Empty string for 204. */
  body: string;
  /** Final URL after redirects — an off-host URL means an SSO bounce. */
  url: string;
}

/** A file the BROWSER downloaded (chrome.downloads) — saved on this machine. */
export interface DownloadResult {
  /** Absolute local path the browser saved the file to. */
  path: string;
  bytes: number;
  mime?: string;
  /** Final URL after redirects (a signed file URL — never return it). */
  finalUrl?: string;
}

export type BridgeStatus = import('@chrischall/mcp-utils/fetchproxy').BridgeHealth;
export type BridgeProbeResult = import('@chrischall/mcp-utils/fetchproxy').BridgeProbeResult;

export interface WorkvivoTransport {
  /** Load the bridge identity. Idempotent; does not bind or dial. */
  start(): Promise<void>;
  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;
  /** Round-trip one request through the bridge. Resolves for any status. */
  fetch(init: FetchInit): Promise<FetchResult>;
  /** Download `url` through the browser's own network stack (follows the
   *  cross-origin redirect to the file host that a page `fetch` cannot). The
   *  file lands in the browser's download folder on THIS machine. */
  download(opts: { url: string; timeoutMs?: number }): Promise<DownloadResult>;
  /** Run one healthcheck probe through `fetchFn` and project bridge health. */
  runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult>;
  /** Diagnostic snapshot of the bridge. */
  status(): BridgeStatus;
}
