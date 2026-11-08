// Where, how big, and which kinds of linked documents this server will fetch.
//
// A Workvivo document link (`/document/link/<id>`, `/file/<id>`) 302s to a
// short-lived signed URL on the tenant's file host (`attachments.<apex>`;
// ~15 s before it expires — verified live). The preferred path:
//
//   1. the bridge CAPTURES that redirect target (`capture_redirect`) — the
//      browser makes the request, so the session cookies ride along, but
//      nothing is downloaded by the browser;
//   2. the file TYPE is checked from the filename the signed URL carries
//      (`response-content-disposition`), before any request;
//   3. the server GETs the signed URL itself with a size cap checked against
//      `Content-Length` before the body is read (`fetchBounded`), and writes it
//      into the configured download directory, never overwriting.
//
// When the capture is unavailable (an older pairing, a browser without
// webRequest), it falls back to the browser's own download into ITS folder,
// applies the same type/size rules to the saved file, then moves it into the
// configured directory and removes the browser's copy.
//
// HOSTED (mcp-host) the server neither reaches the file host (egress is the
// browser's, see mint.yaml) nor shares a disk with the browser, so step 3 is
// `fetchSignedViaBridge`: the BROWSER fetches the signed URL and hands the
// bytes back through the bridge (ContextMint Bridge ≥ 1.8.0). The same host,
// type and size rules apply, with the size cap lowered to what one bridge
// response can carry. Nothing is written to disk; the tool delivers a link.

import { readFile, stat, unlink } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  McpToolError,
  extensionForMime,
  fetchBounded,
  isSafeExtension,
  readEnvVar,
  resolveOutputDir,
  ResponseTooLargeError,
  writeUniqueFile,
} from '@chrischall/mcp-utils';
import { BRIDGE_MAX_BYTES, BridgeResponseTooLargeError, type BytesResult } from './transport.js';

export { BRIDGE_MAX_BYTES };

export const DEFAULT_MAX_DOWNLOAD_MB = 50;
/** Skipped unless WORKVIVO_SKIP_FILE_TYPES says otherwise. */
export const DEFAULT_SKIP_FILE_TYPES = 'video/*,audio/*';

/** Extensions whose MIME family we know without asking the server. */
const EXT_FAMILY: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  webm: 'video/webm', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg', flv: 'video/x-flv', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', wma: 'audio/x-ms-wma',
  pdf: 'application/pdf', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

export interface DownloadPolicy {
  /** Resolved lazily — `resolveOutputDir` creates the directory. */
  dir: () => string;
  maxBytes: number;
  /** Lower-case rules: `.ext`, `type/*`, or `type/subtype`. */
  skip: string[];
}

export class DownloadConfigError extends McpToolError {
  constructor(message: string) {
    super(message, { kind: 'no_credential' });
    this.name = 'DownloadConfigError';
  }
}

/** Parse WORKVIVO_SKIP_FILE_TYPES: `mp4, .mov, video/*, application/zip`; `none` = skip nothing. */
export function parseSkipList(raw: string | undefined): string[] {
  const src = raw === undefined ? DEFAULT_SKIP_FILE_TYPES : raw;
  if (src.trim().toLowerCase() === 'none') return [];
  return src
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => (t.includes('/') || t.startsWith('.') ? t : `.${t}`));
}

export function readDownloadPolicy(env: NodeJS.ProcessEnv = process.env): DownloadPolicy {
  const mbRaw = readEnvVar('WORKVIVO_MAX_DOWNLOAD_MB', { env });
  let mb = DEFAULT_MAX_DOWNLOAD_MB;
  if (mbRaw !== undefined) {
    mb = Number(mbRaw);
    if (!Number.isFinite(mb) || mb <= 0) {
      throw new DownloadConfigError(`WORKVIVO_MAX_DOWNLOAD_MB must be a positive number of megabytes; got ${JSON.stringify(mbRaw)}.`);
    }
  }
  return {
    dir: () => resolveOutputDir(undefined, 'WORKVIVO_DOWNLOAD_DIR', { env, name: 'workvivo-mcp' }),
    maxBytes: Math.floor(mb * 1024 * 1024),
    skip: parseSkipList(readEnvVar('WORKVIVO_SKIP_FILE_TYPES', { env })),
  };
}

/** The rule that skips this file, if any. Matches the extension, then the MIME (or its family). */
export function skipRuleFor(name: string, mime: string | undefined, skip: string[]): string | undefined {
  const ext = extname(name).toLowerCase();
  const m = (mime || EXT_FAMILY[ext.slice(1)] || '').toLowerCase().split(';')[0]!.trim();
  return skip.find((r) => {
    if (r.startsWith('.')) return r === ext;
    if (!m) return false;
    if (r.endsWith('/*')) return m.startsWith(r.slice(0, -1));
    return r === m;
  });
}

/** The filename a signed file URL will be served as (its `response-content-disposition`), else its last path segment. */
export function nameFromSignedUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const disp = u.searchParams.get('response-content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1];
    }
  }
  const last = u.pathname.split('/').pop();
  return last ? decodeURIComponent(last) : undefined;
}

/** Split a filename into a safe stem + extension for `writeUniqueFile`. */
export function fileParts(name: string, mime?: string): { baseName: string; extension: string } {
  const ext = extname(name).slice(1).toLowerCase();
  const extension = ext && isSafeExtension(ext) ? ext : extensionForMime(mime) || 'bin';
  const stem = (ext ? name.slice(0, -(ext.length + 1)) : name).trim() || 'document';
  return { baseName: stem, extension: isSafeExtension(extension) ? extension : 'bin' };
}

export type DownloadOutcome =
  | { kind: 'saved'; path: string; name: string; bytes: number; mime?: string; via: 'direct' | 'browser' }
  | { kind: 'skipped'; name: string; reason: string; bytes?: number; mime?: string }
  /** Hosted: the bytes came through the bridge and are held in memory, not saved. */
  | {
      kind: 'fetched';
      name: string;
      bytes: number;
      mime?: string;
      data: Uint8Array;
      via: 'bridge';
      /** The download link minted for it, reused by later reads while it lasts. */
      link?: { url: string; expiresAt: string };
    };

export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The size refusal on the bridge route, naming the size (when known) and the cap. */
function bridgeTooBig(size: number | null, policy: DownloadPolicy, cap: number): string {
  const what = size !== null ? `${mb(size)}, over` : 'larger than';
  return (
    `${what} the ${mb(cap)} cap for documents read through the browser bridge ` +
    `(the lower of WORKVIVO_MAX_DOWNLOAD_MB, ${mb(policy.maxBytes)}, and the bridge limit, ${mb(BRIDGE_MAX_BYTES)})`
  );
}

/**
 * Hosted path: have the BROWSER GET the captured signed URL and return its
 * bytes through the bridge. Same rules as {@link saveFromSignedUrl} — the
 * host must be the tenant's, a skipped type is refused before any request, and
 * the declared `content-length` / `content-type` are checked before the body
 * is used — with the size cap lowered to `min(WORKVIVO_MAX_DOWNLOAD_MB,
 * 16 MiB)`. Over-cap files are skipped with a reason, never an opaque error.
 */
export async function fetchSignedViaBridge(
  signedUrl: string,
  policy: DownloadPolicy,
  allowedHost: (host: string) => boolean,
  fetchBytes: (url: string) => Promise<BytesResult>,
): Promise<DownloadOutcome> {
  const u = new URL(signedUrl);
  if (u.protocol !== 'https:' || !allowedHost(u.hostname)) {
    throw new McpToolError(`Refusing to fetch a document from ${u.host}: not this Workvivo tenant's file host.`, { kind: 'http' });
  }
  const name = nameFromSignedUrl(signedUrl) ?? 'document';
  const preRule = skipRuleFor(name, undefined, policy.skip);
  if (preRule) return { kind: 'skipped', name, reason: `file type matches WORKVIVO_SKIP_FILE_TYPES rule "${preRule}"` };
  const cap = Math.min(policy.maxBytes, BRIDGE_MAX_BYTES);
  let got: BytesResult;
  try {
    got = await fetchBytes(signedUrl);
  } catch (e) {
    if (e instanceof BridgeResponseTooLargeError) {
      return {
        kind: 'skipped',
        name,
        ...(e.declaredBytes !== null ? { bytes: e.declaredBytes } : {}),
        reason: bridgeTooBig(e.declaredBytes, policy, cap),
      };
    }
    throw e;
  }
  if (got.status < 200 || got.status >= 300) {
    throw new McpToolError(`The Workvivo file host answered HTTP ${got.status} for "${name}".`, {
      status: got.status,
      kind: 'http',
      hint: 'The signed link expires within seconds; retry once.',
    });
  }
  const mime = got.headers['content-type']?.split(';')[0]?.trim() || undefined;
  const declared = Number(got.headers['content-length']);
  const size = Number.isFinite(declared) && declared >= 0 && got.headers['content-length'] !== undefined ? declared : got.bytes.length;
  if (size > cap || got.bytes.length > cap) {
    const n = Math.max(size, got.bytes.length);
    return { kind: 'skipped', name, bytes: n, ...(mime ? { mime } : {}), reason: bridgeTooBig(n, policy, cap) };
  }
  const postRule = skipRuleFor(name, mime, policy.skip);
  if (postRule) return { kind: 'skipped', name, bytes: got.bytes.length, ...(mime ? { mime } : {}), reason: `file type matches WORKVIVO_SKIP_FILE_TYPES rule "${postRule}"` };
  return { kind: 'fetched', name, bytes: got.bytes.length, ...(mime ? { mime } : {}), data: got.bytes, via: 'bridge' };
}

/**
 * Preferred path: GET the captured signed URL server-side and save it.
 * `allowedHost(host)` gates which host the server will fetch.
 */
export async function saveFromSignedUrl(
  signedUrl: string,
  policy: DownloadPolicy,
  allowedHost: (host: string) => boolean,
  fetchImpl?: typeof fetch,
): Promise<DownloadOutcome> {
  const u = new URL(signedUrl);
  if (u.protocol !== 'https:' || !allowedHost(u.hostname)) {
    throw new McpToolError(`Refusing to fetch a document from ${u.host}: not this Workvivo tenant's file host.`, { kind: 'http' });
  }
  const name = nameFromSignedUrl(signedUrl) ?? 'document';
  const preRule = skipRuleFor(name, undefined, policy.skip);
  if (preRule) return { kind: 'skipped', name, reason: `file type matches WORKVIVO_SKIP_FILE_TYPES rule "${preRule}"` };
  let got: Awaited<ReturnType<typeof fetchBounded<'bytes'>>>;
  try {
    got = await fetchBounded(signedUrl, {}, {
      read: 'bytes',
      maxBytes: policy.maxBytes,
      timeoutMs: 120_000,
      service: 'Workvivo file host',
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  } catch (e) {
    if (e instanceof ResponseTooLargeError) {
      return { kind: 'skipped', name, reason: `larger than WORKVIVO_MAX_DOWNLOAD_MB (${mb(policy.maxBytes)})` };
    }
    throw e;
  }
  if (!got.ok) {
    throw new McpToolError(`The Workvivo file host answered HTTP ${got.status} for "${name}".`, {
      status: got.status,
      kind: 'http',
      hint: 'The signed link expires within seconds; retry once.',
    });
  }
  const mime = got.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
  const postRule = skipRuleFor(name, mime, policy.skip);
  if (postRule) return { kind: 'skipped', name, mime, bytes: got.body.length, reason: `file type matches WORKVIVO_SKIP_FILE_TYPES rule "${postRule}"` };
  const path = await writeUniqueFile({ dir: policy.dir(), ...fileParts(name, mime), bytes: got.body });
  return { kind: 'saved', path, name: basename(path), bytes: got.body.length, ...(mime ? { mime } : {}), via: 'direct' };
}

/**
 * Fallback path: the browser already saved the file in ITS folder. Apply the
 * same rules, move it into the configured directory, and remove the original.
 */
export async function adoptBrowserDownload(
  saved: { path: string; bytes: number; mime?: string },
  policy: DownloadPolicy,
): Promise<DownloadOutcome> {
  const name = basename(saved.path);
  const size = (await stat(saved.path)).size;
  const rule = skipRuleFor(name, saved.mime, policy.skip);
  const tooBig = size > policy.maxBytes;
  if (rule || tooBig) {
    await unlink(saved.path).catch(() => undefined);
    return {
      kind: 'skipped',
      name,
      bytes: size,
      ...(saved.mime ? { mime: saved.mime } : {}),
      reason: rule ? `file type matches WORKVIVO_SKIP_FILE_TYPES rule "${rule}"` : `larger than WORKVIVO_MAX_DOWNLOAD_MB (${mb(policy.maxBytes)})`,
    };
  }
  const bytes = new Uint8Array(await readFile(saved.path));
  const path = await writeUniqueFile({ dir: policy.dir(), ...fileParts(name, saved.mime), bytes });
  await unlink(saved.path).catch(() => undefined);
  return { kind: 'saved', path, name: basename(path), bytes: bytes.length, ...(saved.mime ? { mime: saved.mime } : {}), via: 'browser' };
}
