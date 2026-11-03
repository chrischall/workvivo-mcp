import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkvivoApiError } from '../src/client.js';
import { mapDownloadError } from '../src/transport-fetchproxy.js';
import { documentRefOf } from '../src/tools/documents.js';
import { linksAppendix, scopeOf } from '../src/tools/pages.js';
import { HOST, harnessFor, makeClient, payload, textOf } from './helpers.js';
import * as fx from './fixtures.js';

type H = Awaited<ReturnType<typeof harnessFor>>;
let h: H | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});
const call = async (routes: Record<string, unknown>, name: string, args: Record<string, unknown>) => {
  h = await harnessFor(routes);
  return h.harness.client.callTool({ name, arguments: args });
};
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

const dir = mkdtempSync(join(tmpdir(), 'workvivo-pages-'));

describe('scope + refs', () => {
  it('needs exactly one of space_id / page_group_id', () => {
    expect(scopeOf({ space_id: 1 })).toEqual({ space_id: 1 });
    expect(scopeOf({ page_group_id: 2 })).toEqual({ page_group_id: 2 });
    expect(() => scopeOf({})).toThrow(WorkvivoApiError);
    expect(() => scopeOf({ space_id: 1, page_group_id: 2 })).toThrow(/exactly one/);
  });
  it('parses document ids and links, refusing other hosts and paths', () => {
    expect(documentRefOf({ document_id: 5 }, HOST)).toEqual({ kind: 'document', id: 5 });
    expect(documentRefOf({ url: '/document/link/6' }, HOST)).toEqual({ kind: 'document', id: 6 });
    expect(documentRefOf({ url: `https://${HOST}/file/7` }, HOST)).toEqual({ kind: 'file', id: 7 });
    expect(() => documentRefOf({ url: 'https://evil.example.com/document/link/1' }, HOST)).toThrow(/Only Workvivo/);
    expect(() => documentRefOf({ url: '/spaces/1' }, HOST)).toThrow(/Expected/);
    expect(() => documentRefOf({}, HOST)).toThrow(/exactly one/);
    expect(() => documentRefOf({ document_id: 1, url: '/document/link/1' }, HOST)).toThrow(/exactly one/);
  });
  it('maps a not-granted download capability to the re-pair remedy, and passes others through', () => {
    const mapped = mapDownloadError(new Error('capability "download" not granted (declared: [fetch])')) as { hint?: string; kind?: string };
    expect(mapped.kind).toBe('credential_rejected');
    expect(mapped.hint).toMatch(/remove workvivo-mcp/);
    const other = new Error('Failed to fetch');
    expect(mapDownloadError(other)).toBe(other);
  });
  it('the links appendix names the tool to call for each link', () => {
    const md = linksAppendix([
      { kind: 'page', text: 'Goals', url: 'u1', space_id: 30, page: '9004' },
      { kind: 'page', text: 'Year-End', url: 'u2', page_group_id: 248, page: 'year-end' },
      { kind: 'document', text: 'View', url: 'u3', document_id: 501, context: 'Cycle Guide' },
      { kind: 'external', text: 'Ext', url: 'https://example.com' },
    ]);
    expect(md).toContain('- Goals → workvivo_get_page space_id=30 page="9004"');
    expect(md).toContain('page_group_id=248 page="year-end"');
    expect(md).toContain('- View — Cycle Guide → workvivo_get_document document_id=501');
    expect(md).toContain('- [Ext](https://example.com)');
    expect(linksAppendix([])).toBe('');
  });
});

describe('client.getPage', () => {
  it('fetches by slug with content, and the landing page without one', async () => {
    const { client, transport } = makeClient({
      '/api/spaces/30/pages/annual-cycle': { page: fx.tinymcePage },
      '/api/spaces/30/pages': { page: fx.tinymcePage },
    });
    await client.getPage({ space_id: 30 }, 'annual-cycle');
    await client.getPage({ space_id: 30 });
    expect(transport.apiCalls.map((c) => c.path)).toEqual([
      '/api/spaces/30/pages/annual-cycle?include_content=true',
      '/api/spaces/30/pages?include_content=true',
    ]);
  });
  it('resolves a numeric id that is not a slug through the tree', async () => {
    const { client, transport } = makeClient({
      '/api/spaces/30/pages/9002': { status: 404, body: '{"message":"No query results for model [App\\\\Page]."}' },
      '/api/spaces/30/pages-v2': fx.pageTreeResponse,
      '/api/spaces/30/pages/annual-cycle': { page: fx.tinymcePage },
    });
    const out = await client.getPage({ space_id: 30 }, 9002);
    expect((out.page as { id: number }).id).toBe(9002);
    expect(transport.apiCalls.map((c) => c.path)).toEqual([
      '/api/spaces/30/pages/9002?include_content=true',
      '/api/spaces/30/pages-v2?include_content=false',
      '/api/spaces/30/pages/annual-cycle?include_content=true',
    ]);
  });
  it('keeps the 404 when the id is not in the tree, and uses page-group paths', async () => {
    const { client, transport } = makeClient({
      '/api/spaces/30/pages/777': { status: 404, body: '{"message":""}' },
      '/api/spaces/30/pages-v2': fx.pageTreeResponse,
      '/api/pages/248/mid-year': { page: { ...fx.tinymcePage, page_group_id: 248, space_id: null } },
    });
    await expect(client.getPage({ space_id: 30 }, '777')).rejects.toMatchObject({ status: 404 });
    await client.getPage({ page_group_id: 248 }, 'mid-year');
    expect(transport.apiCalls.at(-1)!.path).toBe('/api/pages/248/mid-year?include_content=true');
  });
});

describe('workvivo_list_pages', () => {
  it('returns the tree with drafts flagged and a page count', async () => {
    const r = await call({ '/api/spaces/30/pages-v2': fx.pageTreeResponse }, 'workvivo_list_pages', { space_id: 30 });
    const p = payload(r) as { page_count: number; pages: Array<{ title: string; children: Array<{ draft?: boolean; children?: unknown[] }> }> };
    expect(p.page_count).toBe(4);
    expect(p.pages[0]!.title).toBe('About Us');
    expect(p.pages[0]!.children[1]!.draft).toBe(true);
    expect(p.pages[0]!.children[0]!.children).toHaveLength(1);
    expect(h!.transport.apiCalls[0]!.path).toBe('/api/spaces/30/pages-v2?include_content=false');
  });
});

describe('workvivo_get_page', () => {
  it('returns Markdown with front matter, the untrusted notice, rebased headings and a links appendix', async () => {
    const r = await call({ '/api/spaces/30/pages/annual-cycle': { page: fx.tinymcePage } }, 'workvivo_get_page', { space_id: 30, page: 'annual-cycle' });
    const t = textOf(r);
    expect(t.startsWith('> **Untrusted content.**')).toBe(true);
    expect(t).toContain('title: "Annual Cycle"');
    expect(t).toContain('updated_at: "2026-05-20T15:26:27Z"');
    expect(t).toContain('url: "https://acme.workvivo.us/spaces/30/pages/annual-cycle"');
    expect(t).toContain('# Annual Cycle\n\n## Resources');
    expect(t).toContain('[Cycle Guide](https://acme.workvivo.us/document/link/501)');
    expect(t).toContain('- Cycle Guide — Resources → workvivo_get_document document_id=501');
    expect(t).toContain('workvivo_get_page space_id=30 page="9004"');
    expect(t).toContain('[image: banner]');
    expect(t).not.toContain('SECRETSIG');
  });

  it('renders a Lexical page, and can omit the appendix', async () => {
    const r = await call({ '/api/spaces/30/pages/9004': { page: fx.lexicalPage } }, 'workvivo_get_page', { space_id: 30, page: 9004, include_links: false });
    const t = textOf(r);
    expect(t).toContain('# Goals\n\n## Set your goals');
    expect(t).toContain('[Goal Template](https://acme.workvivo.us/document/link/502)');
    expect(t).not.toContain('Links on this page');
  });

  it('format json carries markdown + classified links', async () => {
    const r = await call({ '/api/spaces/30/pages/9004': { page: fx.lexicalPage } }, 'workvivo_get_page', { space_id: 30, page: '9004', format: 'json' });
    const p = payload(r) as { markdown: string; links: Array<{ document_id: number; context?: string }>; editor: string };
    expect(p.editor).toBe('lexical');
    expect(p.markdown).toContain('## Set your goals');
    expect(p.links.map((l) => l.document_id)).toEqual([502, 503]);
    expect(p.links[1]!.context).toBe('Goal Template (ES)');
  });

  it('errors helpfully when there is no page', async () => {
    const r = await call({ '/api/spaces/30/pages/x': { success: false } }, 'workvivo_get_page', { space_id: 30, page: 'x' });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/workvivo_list_pages/);
  });
});

describe('workvivo_get_document', () => {
  it('downloads through the browser, extracts text and windows it', async () => {
    const path = join(dir, 'Guide.txt');
    writeFileSync(path, 'x'.repeat(1200));
    h = await harnessFor();
    h.transport.downloads[`https://${HOST}/document/link/501`] = { path, bytes: 1200, mime: 'text/plain', finalUrl: 'https://files.example.com/g?Signature=SECRETSIG' };
    let r = await h.harness.client.callTool({ name: 'workvivo_get_document', arguments: { document_id: 501, max_chars: 1000 } });
    let t = textOf(r);
    expect(t).toContain('document_id: 501');
    expect(t).toContain('name: "Guide.txt"');
    expect(t).toContain('total_chars: 1200');
    expect(t).toContain('next_offset: 1000');
    expect(t).not.toContain('SECRETSIG');
    r = await h.harness.client.callTool({ name: 'workvivo_get_document', arguments: { url: '/document/link/501', offset: 1000 } });
    t = textOf(r);
    expect(t).not.toContain('next_offset');
    // The second read reused the file the browser already saved.
    expect(h.transport.downloadCalls).toHaveLength(1);
  });

  it('downloads again when the cached file is gone', async () => {
    const path = join(dir, 'Gone.txt');
    writeFileSync(path, 'hello');
    h = await harnessFor();
    h.transport.downloads[`https://${HOST}/file/9`] = { path, bytes: 5, mime: 'text/plain' };
    await h.harness.client.callTool({ name: 'workvivo_get_document', arguments: { url: `https://${HOST}/file/9` } });
    rmSync(path);
    writeFileSync(join(dir, 'Gone2.txt'), 'again');
    h.transport.downloads[`https://${HOST}/file/9`] = { path: join(dir, 'Gone2.txt'), bytes: 5, mime: 'text/plain' };
    const r = await h.harness.client.callTool({ name: 'workvivo_get_document', arguments: { url: `https://${HOST}/file/9` } });
    expect(textOf(r)).toContain('again');
    expect(h.transport.downloadCalls).toHaveLength(2);
  });

  it('reports the saved path for a type it cannot read, and a sign-in bounce as signed out', async () => {
    const deck = join(dir, 'Deck.pptx');
    writeFileSync(deck, 'PK');
    h = await harnessFor();
    h.transport.downloads[`https://${HOST}/document/link/1`] = { path: deck, bytes: 2 };
    h.transport.downloads[`https://${HOST}/document/link/2`] = { path: join(dir, 'login.html'), bytes: 9, mime: 'text/html', finalUrl: 'https://sso.example.com/idp' };
    const r1 = await h.harness.client.callTool({ name: 'workvivo_get_document', arguments: { document_id: 1 } });
    expect(textOf(r1)).toContain(`saved_to: "${deck}"`);
    expect(textOf(r1)).toMatch(/open the saved file/);
    const r2 = await h.harness.client.callTool({ name: 'workvivo_get_document', arguments: { document_id: 2 } });
    expect(isError(r2)).toBe(true);
    expect(textOf(r2)).toMatch(/Not signed in to Workvivo/);
  });
});

describe('workvivo_digest_space', () => {
  const routes = () => ({
    '/api/spaces/30': { ...fx.spaceList.data[0], enable_pages: true, enable_feed: true, enable_news: false, default_landing_page: 'feed' },
    '/api/spaces/30/pages-v2': fx.pageTreeResponse,
    '/api/spaces/30/pages/about-us': { page: { ...fx.tinymcePage, id: 9001, title: 'About Us', html_content: '<p>Welcome.</p>' } },
    '/api/spaces/30/pages/annual-cycle': { page: fx.tinymcePage },
    '/api/spaces/30/pages/9004': { page: fx.lexicalPage },
    '/api/spaces/30/pages/draft-notes': { status: 500, body: '{"message":"Server Error"}' },
    '/api/spaces/30/documents': { data: [{ id: 77, title: 'Policy Pack' }], next_page_url: null },
    '/api/spaces/30/links': { title: 'Useful Links', body: '<p><a href="https://example.com/hr">HR portal</a></p>' },
    '/api/spaces/30/events': { data: [fx.event], next_page_url: null },
    '/api/spaces/30/feed': fx.feed,
  });

  it('assembles every page, the link index, library, links, events and posts — a failing page does not sink it', async () => {
    const r = await call(routes(), 'workvivo_digest_space', { space_id: 30, feed_items: 2 });
    const t = textOf(r);
    expect(t).toContain('# Company News');
    expect(t).toContain('- Sections enabled: pages, feed');
    expect(t).toMatch(/## Page tree\n\n- About Us \(id 9001, slug "about-us"\)\n {2}- Annual Cycle/);
    expect(t).toContain('[draft]');
    expect(t).toContain('### Annual Cycle');
    expect(t).toContain('#### Resources');
    expect(t).toContain('#### Set your goals');
    expect(t).toMatch(/Could not read page "Draft Notes"/);
    expect(t).toContain('## Documents linked from the pages (3)');
    expect(t).toContain('| 501 | Cycle Guide — Resources | Annual Cycle |');
    expect(t).toContain('| 503 | ES — Goal Template (ES) | Goals |');
    expect(t).toContain('- Goals — Resources — space_id=30 page="9004"');
    expect(t).toContain('## Document library\n\n- Policy Pack (id 77)');
    expect(t).toContain('## Useful Links\n\n[HR portal](https://example.com/hr)');
    expect(t).toContain('**Town Hall** — 2026-11-11T18:00:00Z · Virtual (event_id 8001)');
    expect(t).toContain('## Recent posts (2)');
    expect(t).toContain('pages: 4');
    expect(t).toContain('documents_linked: 3');
    expect(t).not.toContain('SECRETSIG');
    expect(h!.transport.downloadCalls).toHaveLength(0);
  });

  it('extracts linked documents on request, skipping translations and honouring the caps', async () => {
    h = await harnessFor(routes());
    for (const id of [501, 502, 503]) {
      const p = join(dir, `doc-${id}.txt`);
      writeFileSync(p, `Body of ${id} `.repeat(50));
      h.transport.downloads[`https://${HOST}/document/link/${id}`] = { path: p, bytes: 1, mime: 'text/plain' };
    }
    const r = await h.harness.client.callTool({
      name: 'workvivo_digest_space',
      arguments: { space_id: 30, feed_items: 0, include_documents: true, max_documents: 1, max_document_chars: 500 },
    });
    const t = textOf(r);
    expect(t).toContain('## Document contents (1 of 2; 1 translations skipped)');
    expect(t).toContain('Body of 501');
    expect(t).toContain('…truncated; workvivo_get_document document_id=501');
    expect(t).toContain('1 more documents not extracted');
    expect(t).not.toContain('## Recent posts');
    expect(h.transport.downloadCalls).toEqual([`https://${HOST}/document/link/501`]);
  });
});
