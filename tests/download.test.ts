import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  adoptBrowserDownload,
  BRIDGE_MAX_BYTES,
  fetchSignedViaBridge,
  DownloadConfigError,
  fileParts,
  nameFromSignedUrl,
  parseSkipList,
  readDownloadPolicy,
  saveFromSignedUrl,
  skipRuleFor,
} from '../src/download.js';
import { testPolicy } from './helpers.js';
import { BridgeResponseTooLargeError, type BytesResult } from '../src/transport.js';

const signed = (name: string, host = 'attachments.workvivo.us') =>
  `https://${host}/uploads/1/2/abc.bin?response-content-disposition=${encodeURIComponent(`filename="${name}"`)}&Expires=1&Signature=SIG&Key-Pair-Id=K`;
const tenant = (h: string) => h === 'workvivo.us' || h.endsWith('.workvivo.us');

/** A fetch stub answering one response; records whether the body was read. */
function fakeFetch(body: Uint8Array, headers: Record<string, string>, status = 200) {
  const state = { calls: 0, bodyRead: false };
  const impl = (async () => {
    state.calls++;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        state.bodyRead = true;
        c.enqueue(body);
        c.close();
      },
    }, { highWaterMark: 0 }); // pull only when someone actually reads
    return new Response(stream, { status, headers });
  }) as unknown as typeof fetch;
  return { impl, state };
}

describe('policy parsing', () => {
  it('defaults to skipping video and audio; accepts bare and dotted extensions and MIME rules; "none" skips nothing', () => {
    expect(parseSkipList(undefined)).toEqual(['video/*', 'audio/*']);
    expect(parseSkipList('mp4, .MOV ; video/* application/zip')).toEqual(['.mp4', '.mov', 'video/*', 'application/zip']);
    expect(parseSkipList('none')).toEqual([]);
    expect(parseSkipList('')).toEqual([]);
  });

  it('reads the env: size in MB, a custom dir, and refuses a bad size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-env-'));
    const p = readDownloadPolicy({ WORKVIVO_MAX_DOWNLOAD_MB: '2.5', WORKVIVO_DOWNLOAD_DIR: dir, WORKVIVO_SKIP_FILE_TYPES: 'pptx' });
    expect(p.maxBytes).toBe(Math.floor(2.5 * 1024 * 1024));
    expect(p.skip).toEqual(['.pptx']);
    expect(p.dir()).toBe(dir);
    expect(readDownloadPolicy({}).maxBytes).toBe(50 * 1024 * 1024);
    // An unset .mcpb user_config arrives as "" or an unexpanded placeholder: defaults apply.
    for (const unset of ['', '   ', '${user_config.max_download_mb}']) {
      const q = readDownloadPolicy({ WORKVIVO_MAX_DOWNLOAD_MB: unset, WORKVIVO_SKIP_FILE_TYPES: unset });
      expect(q.maxBytes).toBe(50 * 1024 * 1024);
      expect(q.skip).toEqual(['video/*', 'audio/*']);
    }
    for (const bad of ['0', '-1', 'big']) {
      expect(() => readDownloadPolicy({ WORKVIVO_MAX_DOWNLOAD_MB: bad })).toThrow(DownloadConfigError);
    }
  });

  it('matches skip rules by extension, MIME, and MIME family (known from the extension)', () => {
    const skip = parseSkipList('video/*,.zip,application/x-msdownload');
    expect(skipRuleFor('Town Hall.MP4', undefined, skip)).toBe('video/*');
    expect(skipRuleFor('clip.bin', 'video/webm; codecs=vp9', skip)).toBe('video/*');
    expect(skipRuleFor('pack.zip', undefined, skip)).toBe('.zip');
    expect(skipRuleFor('setup', 'application/x-msdownload', skip)).toBe('application/x-msdownload');
    expect(skipRuleFor('guide.pdf', 'application/pdf', skip)).toBeUndefined();
    expect(skipRuleFor('notes', undefined, skip)).toBeUndefined();
  });

  it('reads the served filename from the signed URL and splits it safely', () => {
    expect(nameFromSignedUrl(signed('Hiring Toolkit.pdf'))).toBe('Hiring Toolkit.pdf');
    expect(nameFromSignedUrl('https://h/x/My%20File.docx?Expires=1')).toBe('My File.docx');
    expect(nameFromSignedUrl('not a url')).toBeUndefined();
    expect(fileParts('Hiring Toolkit.pdf')).toEqual({ baseName: 'Hiring Toolkit', extension: 'pdf' });
    expect(fileParts('README', 'application/pdf')).toEqual({ baseName: 'README', extension: 'pdf' });
    expect(fileParts('weird.p df', undefined).extension).toBe('bin');
  });
});

describe('saveFromSignedUrl (the direct path)', () => {
  it('saves into the configured dir under the served name, never overwriting', async () => {
    const policy = testPolicy();
    const f = fakeFetch(new Uint8Array([37, 80, 68, 70]), { 'content-type': 'application/pdf', 'content-length': '4' });
    const a = await saveFromSignedUrl(signed('Guide.pdf'), policy, tenant, f.impl);
    const b = await saveFromSignedUrl(signed('Guide.pdf'), policy, tenant, f.impl);
    expect(a).toMatchObject({ kind: 'saved', name: 'Guide.pdf', bytes: 4, mime: 'application/pdf', via: 'direct', path: join(policy.root, 'Guide.pdf') });
    expect(b).toMatchObject({ kind: 'saved', name: 'Guide-2.pdf' });
    expect(readFileSync(join(policy.root, 'Guide.pdf'), 'latin1')).toBe('%PDF');
  });

  it('keeps a hostile served filename inside the download dir', async () => {
    const policy = testPolicy();
    const f = fakeFetch(new Uint8Array([1]), { 'content-type': 'application/pdf' });
    for (const evil of ['../../evil.pdf', '/etc/evil.pdf', '..\\..\\evil.pdf']) {
      const out = await saveFromSignedUrl(signed(evil), policy, tenant, f.impl);
      expect(out.kind).toBe('saved');
      const p = (out as { path: string }).path;
      expect(p.startsWith(policy.root + '/')).toBe(true);
      expect(p.slice(policy.root.length + 1)).not.toMatch(/[\\/]|^\.\.$/);
    }
  });

  it('skips a filtered type WITHOUT making any request', async () => {
    const policy = testPolicy();
    const f = fakeFetch(new Uint8Array(1), {});
    const out = await saveFromSignedUrl(signed('Town Hall.mp4'), policy, tenant, f.impl);
    expect(out).toEqual({ kind: 'skipped', name: 'Town Hall.mp4', reason: 'file type matches WORKVIVO_SKIP_FILE_TYPES rule "video/*"' });
    expect(f.state.calls).toBe(0);
  });

  it('skips an oversized file from Content-Length WITHOUT reading the body', async () => {
    const policy = testPolicy({ maxBytes: 1024 });
    const f = fakeFetch(new Uint8Array(10), { 'content-type': 'application/pdf', 'content-length': String(5 * 1024 * 1024) });
    const out = await saveFromSignedUrl(signed('Big.pdf'), policy, tenant, f.impl);
    expect(out).toMatchObject({ kind: 'skipped', name: 'Big.pdf' });
    expect((out as { reason: string }).reason).toMatch(/larger than WORKVIVO_MAX_DOWNLOAD_MB \(0\.0 MB\)/);
    expect(f.state.bodyRead).toBe(false);
  });

  it('skips by the served MIME when the name gave nothing away', async () => {
    const policy = testPolicy();
    const f = fakeFetch(new Uint8Array(3), { 'content-type': 'audio/mpeg' });
    const out = await saveFromSignedUrl(signed('recording'), policy, tenant, f.impl);
    expect(out).toMatchObject({ kind: 'skipped', mime: 'audio/mpeg' });
    expect(existsSync(join(policy.root, 'recording.mp3'))).toBe(false);
  });

  it('refuses a host outside the tenant, and http', async () => {
    const f = fakeFetch(new Uint8Array(1), {});
    await expect(saveFromSignedUrl(signed('a.pdf', 'evil.example.com'), testPolicy(), tenant, f.impl)).rejects.toThrow(/not this Workvivo tenant/);
    await expect(saveFromSignedUrl(signed('a.pdf').replace('https:', 'http:'), testPolicy(), tenant, f.impl)).rejects.toThrow(/not this Workvivo tenant/);
    expect(f.state.calls).toBe(0);
  });

  it('a non-2xx from the file host is an error naming the expiry', async () => {
    const f = fakeFetch(new TextEncoder().encode('<Error/>'), { 'content-type': 'text/xml' }, 403);
    await expect(saveFromSignedUrl(signed('a.pdf'), testPolicy(), tenant, f.impl)).rejects.toMatchObject({ status: 403, hint: expect.stringMatching(/expires/) });
  });
});

describe('adoptBrowserDownload (the fallback path)', () => {
  const browserFile = (name: string, bytes: number) => {
    const d = mkdtempSync(join(tmpdir(), 'wv-browser-'));
    const p = join(d, name);
    writeFileSync(p, Buffer.alloc(bytes, 65));
    return p;
  };

  it('moves the browser\'s file into the configured dir and removes the original', async () => {
    const policy = testPolicy();
    const src = browserFile('Guide (1).pdf', 10);
    const out = await adoptBrowserDownload({ path: src, bytes: 10, mime: 'application/pdf' }, policy);
    expect(out).toMatchObject({ kind: 'saved', via: 'browser', name: 'Guide (1).pdf', bytes: 10, path: join(policy.root, 'Guide (1).pdf') });
    expect(existsSync(src)).toBe(false);
  });

  it('deletes and skips a file over the cap or of a skipped type', async () => {
    const big = browserFile('Big.pdf', 2048);
    expect(await adoptBrowserDownload({ path: big, bytes: 2048 }, testPolicy({ maxBytes: 1024 }))).toMatchObject({ kind: 'skipped', bytes: 2048 });
    expect(existsSync(big)).toBe(false);
    const vid = browserFile('Clip.mov', 5);
    expect(await adoptBrowserDownload({ path: vid, bytes: 5 }, testPolicy())).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(/video\/\*/) });
    expect(existsSync(vid)).toBe(false);
  });
});

describe('client.downloadDocument', () => {
  it('captures the signed URL, fetches it directly, and caches the saved file', async () => {
    const { makeClient } = await import('./helpers.js');
    const f = fakeFetch(new Uint8Array([1, 2]), { 'content-type': 'application/pdf' });
    const { client, transport } = makeClient({}, { fetchImpl: f.impl });
    transport.captures['/document/link/5'] = signed('Five.pdf');
    const a = await client.downloadDocument({ kind: 'document', id: 5 });
    const b = await client.downloadDocument({ kind: 'document', id: 5 });
    expect(a).toMatchObject({ kind: 'saved', via: 'direct', name: 'Five.pdf' });
    expect(b).toBe(a);
    expect(transport.captureCalls).toEqual(['/document/link/5']);
    expect(transport.downloadCalls).toEqual([]);
  });

  it('falls back to the browser download when the capture is unavailable, and says so on stderr', async () => {
    const { makeClient, HOST } = await import('./helpers.js');
    const { client, transport } = makeClient();
    const d = mkdtempSync(join(tmpdir(), 'wv-fb-'));
    writeFileSync(join(d, 'Six.pdf'), 'x');
    transport.downloads[`https://${HOST}/file/6`] = { path: join(d, 'Six.pdf'), bytes: 1, mime: 'application/pdf' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await client.downloadDocument({ kind: 'file', id: 6 });
    expect(out).toMatchObject({ kind: 'saved', via: 'browser', name: 'Six.pdf' });
    expect(err.mock.calls.flat().join(' ')).toMatch(/falling back to a browser download/);
    err.mockRestore();
  });

  it('a capture landing on the tenant sign-in page is a signed-out session, with no fallback', async () => {
    const { makeClient, HOST } = await import('./helpers.js');
    const { client, transport } = makeClient();
    transport.captures['/document/link/7'] = `https://${HOST}/saml/sso`;
    await expect(client.downloadDocument({ kind: 'document', id: 7 })).rejects.toThrow(/Not signed in to Workvivo/);
    expect(transport.downloadCalls).toEqual([]);
  });

  it('a bad download policy surfaces on the first document read', async () => {
    const { makeClient } = await import('./helpers.js');
    const { client } = makeClient({}, { downloadPolicy: new DownloadConfigError('WORKVIVO_MAX_DOWNLOAD_MB must be positive') });
    await expect(client.downloadDocument({ kind: 'document', id: 1 })).rejects.toThrow(/WORKVIVO_MAX_DOWNLOAD_MB/);
  });
});

describe('fetchSignedViaBridge (hosted: the bytes come through the browser)', () => {
  const MiB = 1024 * 1024;
  const answer = (bytes: Uint8Array, headers: Record<string, string>, status = 200) => {
    const calls: string[] = [];
    const fn = async (url: string): Promise<BytesResult> => {
      calls.push(url);
      return { status, url, headers, bytes };
    };
    return { fn, calls };
  };

  it('returns the bytes exactly, with the declared mime (parameters stripped)', async () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const { fn, calls } = answer(data, { 'content-type': 'application/pdf; charset=binary', 'content-length': '6' });
    const out = await fetchSignedViaBridge(signed('Guide.pdf'), testPolicy(), tenant, fn);
    expect(out).toMatchObject({ kind: 'fetched', name: 'Guide.pdf', bytes: 6, mime: 'application/pdf', via: 'bridge' });
    expect(out.kind === 'fetched' && [...out.data]).toEqual([...data]);
    expect(calls).toEqual([signed('Guide.pdf')]);
  });

  it('caps at the lower of WORKVIVO_MAX_DOWNLOAD_MB and the bridge limit, naming the size and the cap', async () => {
    expect(BRIDGE_MAX_BYTES).toBe(16 * MiB);
    const { fn } = answer(new Uint8Array(1), { 'content-length': String(20 * MiB) });
    const out = await fetchSignedViaBridge(signed('Big.pdf'), testPolicy(), tenant, fn);
    expect(out.kind).toBe('skipped');
    expect(out.kind === 'skipped' && out.reason).toBe(
      '20.0 MB, over the 16.0 MB cap for documents read through the browser bridge (the lower of WORKVIVO_MAX_DOWNLOAD_MB, 50.0 MB, and the bridge limit, 16.0 MB)',
    );
  });

  it('checks the body length too when content-length is missing', async () => {
    const { fn } = answer(new Uint8Array(2048), {});
    const out = await fetchSignedViaBridge(signed('NoLen.pdf'), testPolicy({ maxBytes: 1024 }), tenant, fn);
    expect(out).toMatchObject({ kind: 'skipped', bytes: 2048 });
  });

  it('skips by the declared content-type after the fetch when the name says nothing', async () => {
    const { fn } = answer(new Uint8Array(4), { 'content-type': 'video/mp4' });
    const out = await fetchSignedViaBridge(signed('clip'), testPolicy(), tenant, fn);
    expect(out).toMatchObject({ kind: 'skipped', mime: 'video/mp4', reason: 'file type matches WORKVIVO_SKIP_FILE_TYPES rule "video/*"' });
  });

  it('refuses a skipped type and a foreign host before asking the bridge', async () => {
    const { fn, calls } = answer(new Uint8Array(1), {});
    expect(await fetchSignedViaBridge(signed('a.mov'), testPolicy(), tenant, fn)).toMatchObject({ kind: 'skipped' });
    await expect(fetchSignedViaBridge(signed('a.pdf', 'files.example.com'), testPolicy(), tenant, fn)).rejects.toThrow(/not this Workvivo tenant's file host/);
    await expect(fetchSignedViaBridge(signed('a.pdf').replace('https:', 'http:'), testPolicy(), tenant, fn)).rejects.toThrow(/file host/);
    expect(calls).toEqual([]);
  });

  it('maps a bridge size refusal to a skip, with or without a declared size', async () => {
    const tooBig = (declaredBytes: number | null) => async (): Promise<BytesResult> => {
      throw new BridgeResponseTooLargeError({ limitBytes: 16 * MiB, declaredBytes });
    };
    expect(await fetchSignedViaBridge(signed('a.pdf'), testPolicy(), tenant, tooBig(30 * MiB))).toMatchObject({
      kind: 'skipped',
      bytes: 30 * MiB,
      reason: expect.stringMatching(/^30\.0 MB, over the 16\.0 MB cap/),
    });
    expect(await fetchSignedViaBridge(signed('a.pdf'), testPolicy(), tenant, tooBig(null))).toMatchObject({
      kind: 'skipped',
      reason: expect.stringMatching(/^larger than the 16\.0 MB cap/),
    });
  });

  it('surfaces a non-2xx from the file host with the retry hint', async () => {
    const { fn } = answer(new Uint8Array(0), {}, 403);
    await expect(fetchSignedViaBridge(signed('a.pdf'), testPolicy(), tenant, fn)).rejects.toMatchObject({ status: 403, hint: expect.stringMatching(/retry once/) });
  });

  it('passes other bridge errors through', async () => {
    const boom = new Error('bridge down');
    await expect(fetchSignedViaBridge(signed('a.pdf'), testPolicy(), tenant, async () => { throw boom; })).rejects.toBe(boom);
  });
});
