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

import { McpToolError } from '@chrischall/mcp-utils';

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

/** A response whose body came back through the bridge as BYTES, intact. */
export interface BytesResult {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Lower-cased; only `content-type`, `content-length`, `content-disposition`, each when sent. */
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/** Most bytes one bridge response can carry (fetchproxy's `MAX_BINARY_RESPONSE_BYTES`). */
export const BRIDGE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The paired ContextMint Bridge predates binary fetch (1.8.0), so it cannot
 * hand a document's bytes over. Updating the extension is the only fix;
 * re-pairing changes nothing.
 */
export class ExtensionUpdateRequiredError extends McpToolError {
  constructor(cause?: unknown) {
    super(
      'ContextMint Bridge must be updated to 1.8.0 or later to read Workvivo documents on a hosted server: ' +
        'the installed version cannot return file contents through the bridge.',
      {
        kind: 'unknown',
        ...(cause !== undefined ? { cause } : {}),
        hint:
          'Update ContextMint Bridge (Chrome Web Store / App Store, or reload a sideloaded copy), then retry. ' +
          'Your pairing is fine and does not need to be redone.',
      },
    );
    this.name = 'ExtensionUpdateRequiredError';
  }
}

/** The bridge refused a body over its per-response cap. Callers turn this into a skip. */
export class BridgeResponseTooLargeError extends Error {
  readonly limitBytes: number;
  readonly declaredBytes: number | null;
  constructor(info: { limitBytes: number | null; declaredBytes: number | null }, cause?: unknown) {
    const limit = info.limitBytes ?? BRIDGE_MAX_BYTES;
    super(`the file is larger than the ${limit}-byte cap one bridge response can carry`, cause !== undefined ? { cause } : undefined);
    this.name = 'BridgeResponseTooLargeError';
    this.limitBytes = limit;
    this.declaredBytes = info.declaredBytes;
  }
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
  /** The URL that `path` on the Workvivo host redirects to, observed as the
   *  browser follows it (nothing is downloaded). For document links that is a
   *  short-lived signed file URL. */
  captureSignedUrl(path: string): Promise<string>;
  /** GET an absolute URL (a captured signed file URL) through the browser and
   *  return the body as bytes — the hosted route to a document, since the
   *  bytes never touch this process's own network. Rejects with
   *  {@link ExtensionUpdateRequiredError} for an extension without binary
   *  fetch and {@link BridgeResponseTooLargeError} over the bridge's cap. */
  fetchBytes(url: string): Promise<BytesResult>;
  /** Run one healthcheck probe through `fetchFn` and project bridge health. */
  runProbe(fetchFn: (path: string) => Promise<unknown>, probePath: string): Promise<BridgeProbeResult>;
  /** Diagnostic snapshot of the bridge. */
  status(): BridgeStatus;
}
