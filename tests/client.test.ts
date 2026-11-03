import { describe, expect, it } from 'vitest';
import {
  WorkvivoApiError,
  WorkvivoClient,
  WorkvivoConfigError,
  WorkvivoSessionError,
  extractCsrfToken,
  normalizeHost,
  withQuery,
} from '../src/client.js';
import { HOST, StubTransport, TOKEN, makeClient } from './helpers.js';

describe('normalizeHost', () => {
  it('accepts a bare host, a URL, and a pasted page URL', () => {
    expect(normalizeHost('acme.workvivo.us')).toBe('acme.workvivo.us');
    expect(normalizeHost('  https://Acme.Workvivo.us/ ')).toBe('acme.workvivo.us');
    expect(normalizeHost('https://acme.workvivo.com/news/123?x=1')).toBe('acme.workvivo.com');
  });
  it('treats unset/blank as unconfigured', () => {
    expect(normalizeHost(undefined)).toBeUndefined();
    expect(normalizeHost('   ')).toBeUndefined();
  });
  it('rejects things that are not hostnames', () => {
    for (const bad of ['acme', 'ftp://acme.workvivo.us', 'https://u:p@acme.workvivo.us', 'acme.workvivo.us:8443', 'a b.com']) {
      expect(() => normalizeHost(bad), bad).toThrow(WorkvivoConfigError);
    }
  });
});

describe('extractCsrfToken / withQuery', () => {
  it('reads the meta tag in either attribute order', () => {
    expect(extractCsrfToken('<meta name="csrf_token" content="abc">')).toBe('abc');
    expect(extractCsrfToken("<meta content='xyz' name='csrf_token'>")).toBe('xyz');
    expect(extractCsrfToken('<html></html>')).toBeUndefined();
  });
  it('drops empty values and appends to an existing query', () => {
    expect(withQuery('people', { page: 2, query: undefined, q: '', x: null })).toBe('people?page=2');
    expect(withQuery('a?b=1', { c: 'd e' })).toBe('a?b=1&c=d+e');
    expect(withQuery('a')).toBe('a');
  });
});

describe('WorkvivoClient', () => {
  it('reads the CSRF token once and sends it with the XHR headers', async () => {
    const { transport, client } = makeClient({ '/api/user': { id: 1 } });
    await client.get('user');
    await client.get('/api/user');
    expect(transport.calls.filter((c) => c.path === '/')).toHaveLength(1);
    expect(transport.apiCalls).toHaveLength(2);
    expect(transport.apiCalls[0]!.headers).toMatchObject({
      'X-CSRF-Token': TOKEN,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    });
    expect(transport.apiCalls[1]!.path).toBe('/api/user');
  });

  it('single-flights the token fetch across concurrent calls', async () => {
    const { transport, client } = makeClient({ '/api/a': {}, '/api/b': {} });
    await Promise.all([client.get('a'), client.get('b')]);
    expect(transport.calls.filter((c) => c.path === '/')).toHaveLength(1);
  });

  it('re-reads the token and retries once on 401, then succeeds', async () => {
    let n = 0;
    const { transport, client } = makeClient({
      '/api/user': () => (++n === 1 ? { status: 401, body: '{"message":"Unauthenticated."}' } : { body: '{"ok":true}' }),
    });
    await expect(client.get('user')).resolves.toEqual({ ok: true });
    expect(transport.calls.filter((c) => c.path === '/')).toHaveLength(2);
  });

  it('treats a second 401 (or 419) as a signed-out session', async () => {
    const { client } = makeClient({ '/api/user': { status: 419, body: '' } });
    const err = await client.get('user').catch((e) => e);
    expect(err).toBeInstanceOf(WorkvivoSessionError);
    expect(err.kind).toBe('session_expired');
    expect(err.message).toContain(`https://${HOST}`);
  });

  it('treats an SSO bounce while reading the token as signed out', async () => {
    const { client } = makeClient({ '/': { url: 'https://sso.example.com/idp/login' } });
    await expect(client.get('user')).rejects.toBeInstanceOf(WorkvivoSessionError);
  });

  it('treats a /saml or /login landing on an API call as signed out', async () => {
    const { client } = makeClient({ '/api/user': { url: `https://${HOST}/saml/sso`, body: '<html>' } });
    await expect(client.get('user')).rejects.toBeInstanceOf(WorkvivoSessionError);
  });

  it('treats a shell with no token as signed out', async () => {
    const { client } = makeClient({ '/': { body: '<html>sign in</html>' } });
    const err = await client.get('user').catch((e) => e);
    expect(err).toBeInstanceOf(WorkvivoSessionError);
    expect(err.message).toContain('no session token');
  });

  it('surfaces a failing home page as an API error', async () => {
    const { client } = makeClient({ '/': { status: 503, body: 'down' } });
    const err = await client.get('user').catch((e) => e);
    expect(err).toBeInstanceOf(WorkvivoApiError);
    expect(err.status).toBe(503);
  });

  it('maps 403, 404, 422 and 500 with Workvivo\'s own message', async () => {
    const { client } = makeClient({
      '/api/f': { status: 403, body: '{"message":"This action is unauthorized."}' },
      '/api/n': { status: 404, body: '<html>nope</html>' },
      '/api/v': { status: 422, body: '{"message":"The query field is required."}' },
      '/api/s': { status: 500, body: '{"message":"Server Error"}' },
    });
    const f = await client.get('f').catch((e) => e);
    expect(f.status).toBe(403);
    expect(f.message).toContain('This action is unauthorized.');
    expect(f.hint).toMatch(/not permitted/);
    const n = await client.get('n').catch((e) => e);
    expect(n.status).toBe(404);
    expect(n.message).not.toContain('<html>');
    const v = await client.get('v').catch((e) => e);
    expect(v.status).toBe(422);
    expect(v.message).toContain('The query field is required.');
    const s = await client.get('s').catch((e) => e);
    expect(s.status).toBe(500);
    expect(s.hint).toMatch(/check the id/i);
  });

  it('returns null for an empty 2xx body', async () => {
    const { client } = makeClient({ '/api/spaces/featured': { body: ' ' } });
    await expect(client.get('spaces/featured')).resolves.toBeNull();
  });

  it('posts JSON with retry-on-timeout (search is read-only)', async () => {
    const { transport, client } = makeClient({ '/api/federated-search': { data: [] } });
    await client.postJson('federated-search', { query: 'x' });
    const call = transport.apiCalls[0]!;
    expect(call.method).toBe('POST');
    expect(call.body).toBe('{"query":"x"}');
    expect(call.retryOnTimeout).toBe(true);
    expect(call.headers?.['Content-Type']).toBe('application/json');
  });

  it('defers a missing host to the first call', async () => {
    const transport = new StubTransport();
    const client = new WorkvivoClient({ transport, host: undefined });
    expect(client.hostLabel).toBe('<WORKVIVO_HOST>');
    await expect(client.get('user')).rejects.toBeInstanceOf(WorkvivoConfigError);
    expect(transport.calls).toHaveLength(0);
  });

  it('prefers an explicit boot config error', async () => {
    const client = new WorkvivoClient({
      transport: new StubTransport(),
      host: HOST,
      configError: new WorkvivoConfigError('WORKVIVO_WS_PORT is not a port'),
    });
    await expect(client.get('user')).rejects.toThrow('WORKVIVO_WS_PORT');
  });
});
