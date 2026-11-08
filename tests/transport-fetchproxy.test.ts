import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FetchproxyExtensionUpdateRequiredError,
  FetchproxyResponseTooLargeError,
  FetchproxyProtocolError,
} from '@fetchproxy/server';

// Capture what the transport asks the shared factory for, and hand back a fake
// inner transport whose raw server is a spy.
const made: { opts?: Record<string, unknown>; server: { getBytes: ReturnType<typeof vi.fn> } } = {
  server: { getBytes: vi.fn() },
};
vi.mock('@chrischall/mcp-utils/fetchproxy', async (importOriginal) => {
  const real = await importOriginal<typeof import('@chrischall/mcp-utils/fetchproxy')>();
  return {
    ...real,
    createFetchproxyTransport: (opts: Record<string, unknown>) => {
      made.opts = opts;
      return { server: made.server };
    },
  };
});

const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
const { BridgeResponseTooLargeError, ExtensionUpdateRequiredError } = await import('../src/transport.js');

const FILE = 'https://attachments.workvivo.us/uploads/1/2/abc.pdf?Expires=1&Signature=S';

/** fetchproxy's own domain rule: the host is a declared domain or a subdomain of one. */
const covered = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

describe('FetchproxyTransport (binary document fetch)', () => {
  beforeEach(() => {
    made.server.getBytes = vi.fn();
  });

  it("the pairing's declared domains cover the tenant's file host, without widening the set", () => {
    new FetchproxyTransport({ host: 'acme.workvivo.us', version: '0.0.0' });
    const domains = made.opts!.domains as string[];
    // Unchanged from earlier releases: a different set forces every existing
    // pairing through a re-pair prompt, and the apex already covers the file host.
    expect(domains).toEqual(['workvivo.us']);
    expect(covered(new URL(FILE).hostname, domains)).toBe(true);
    expect(made.opts!.capabilities).toEqual(['fetch', 'capture_redirect', 'download']);
  });

  it('fetches the signed URL as an absolute URL from the background, without cookies, and returns the bytes', async () => {
    const t = new FetchproxyTransport({ host: 'acme.workvivo.us', version: '0.0.0' });
    const bytes = new Uint8Array([1, 2, 3]);
    made.server.getBytes.mockResolvedValue({ status: 200, url: FILE, headers: { 'content-type': 'application/pdf' }, bytes });
    const res = await t.fetchBytes(FILE);
    expect(made.server.getBytes).toHaveBeenCalledWith(FILE, { credentials: 'omit' });
    expect(res).toEqual({ status: 200, url: FILE, headers: { 'content-type': 'application/pdf' }, bytes });
  });

  it('an extension without binary fetch becomes the update-required tool error', async () => {
    const t = new FetchproxyTransport({ host: 'acme.workvivo.us', version: '0.0.0' });
    made.server.getBytes.mockRejectedValue(
      new FetchproxyExtensionUpdateRequiredError('extension lacks fetch_base64', { feature: 'fetch_base64' }),
    );
    const err = await t.fetchBytes(FILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionUpdateRequiredError);
    expect((err as Error).message).toMatch(/ContextMint Bridge must be updated to 1\.8\.0 or later/);
    expect((err as { hint?: string }).hint).toMatch(/Update ContextMint Bridge/);
  });

  it('a body over the bridge cap becomes BridgeResponseTooLargeError, keeping the sizes', async () => {
    const t = new FetchproxyTransport({ host: 'acme.workvivo.us', version: '0.0.0' });
    made.server.getBytes.mockRejectedValue(
      new FetchproxyResponseTooLargeError('response too large', { limitBytes: 16_777_216, declaredBytes: 20_000_000 }),
    );
    const err = await t.fetchBytes(FILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeResponseTooLargeError);
    expect(err).toMatchObject({ limitBytes: 16_777_216, declaredBytes: 20_000_000 });
  });

  it('a file host that redirects outside the paired domains gets a clear refusal', async () => {
    const t = new FetchproxyTransport({ host: 'acme.workvivo.us', version: '0.0.0' });
    made.server.getBytes.mockRejectedValue(new Error('final url host cdn.example.net (after redirects) not in domains [workvivo.us]'));
    const err = await t.fetchBytes(FILE).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/outside workvivo\.us/);
    expect((err as { hint?: string }).hint).toMatch(/open the document in Workvivo/i);
    made.server.getBytes.mockRejectedValue(
      new FetchproxyProtocolError('FetchproxyServer: requestBytes final url host "cdn.example.net" is outside declared domains ["workvivo.us"]'),
    );
    expect(((await t.fetchBytes(FILE).catch((e: unknown) => e)) as Error).message).toMatch(/outside workvivo\.us/);
  });

  it('an older pairing refusing a capability keeps the re-pair remedy; anything else passes through', async () => {
    const t = new FetchproxyTransport({ host: 'acme.workvivo.us', version: '0.0.0' });
    made.server.getBytes.mockRejectedValue(new Error('capability "fetch" not granted (declared: [])'));
    expect(await t.fetchBytes(FILE).catch((e: unknown) => e)).toMatchObject({ hint: expect.stringMatching(/remove workvivo-mcp/) });
    const other = new Error('bridge down');
    made.server.getBytes.mockRejectedValue(other);
    expect(await t.fetchBytes(FILE).catch((e: unknown) => e)).toBe(other);
  });
});
