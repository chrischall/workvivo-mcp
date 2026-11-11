import { afterEach, describe, expect, it } from 'vitest';
import { assertReadPath } from '../src/tools/raw.js';
import { harnessFor, payload, textOf } from './helpers.js';
import * as fx from './fixtures.js';

type H = Awaited<ReturnType<typeof harnessFor>>;
let h: H | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

async function call(routes: Record<string, unknown>, name: string, args: Record<string, unknown> = {}) {
  h = await harnessFor(routes);
  const result = await h.harness.client.callTool({ name, arguments: args });
  return { result, transport: h.transport };
}

const paths = (t: H['transport']) => t.apiCalls.map((c) => c.path);

describe('every read is fenced as untrusted', () => {
  it('wraps compact results in the untrusted envelope', async () => {
    const { result } = await call({ '/api/activity': fx.feed }, 'workvivo_get_feed');
    const p = payload(result);
    expect(p.untrusted_content).toBe(true);
    expect(String(p.note)).toMatch(/other Workvivo users/);
  });
});

describe('workvivo_get_feed', () => {
  it('reads the home feed, compact by default, cursor passed through', async () => {
    const { result, transport } = await call({ '/api/activity': fx.feed }, 'workvivo_get_feed', { cursor: 'abc' });
    expect(paths(transport)).toEqual(['/api/activity?next_cursor=abc']);
    const p = payload(result) as { items: Array<Record<string, unknown>>; next_cursor: string };
    expect(p.items).toHaveLength(4);
    expect(p.items[0]).toMatchObject({ type: 'update', id: 5001, by: 'Alice Example' });
    expect(p.next_cursor).toBe('eyJjdXJzb3IiOjF9');
  });

  it('routes space and person feeds', async () => {
    let r = await call({ '/api/spaces/30/feed': fx.feed }, 'workvivo_get_feed', { space_id: 30 });
    expect(paths(r.transport)).toEqual(['/api/spaces/30/feed']);
    await h!.harness.close();
    r = await call({ '/api/people/101/feed': { data: [], next_page_url: null } }, 'workvivo_get_feed', { person_id: '101', page: 2 });
    expect(paths(r.transport)).toEqual(['/api/people/101/feed?page=2&removenoise=true']);
  });

  it('refuses space_id + person_id together', async () => {
    const { result, transport } = await call({}, 'workvivo_get_feed', { space_id: 1, person_id: 2 });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/not both/);
    expect(transport.apiCalls).toHaveLength(0);
  });

  it('full returns the record as sent (minus credentials) and never sends `view` upstream', async () => {
    const { result, transport } = await call({ '/api/activity': fx.feed }, 'workvivo_get_feed', { view: 'full' });
    expect(paths(transport)).toEqual(['/api/activity']);
    const p = payload(result) as { data: unknown[]; per_page: number };
    expect(p.per_page).toBe(5);
    expect(JSON.stringify(p)).toContain('avatar_url');
  });
});

describe('news', () => {
  it('lists articles with next_page', async () => {
    const { result, transport } = await call({ '/api/articles': fx.articleList }, 'workvivo_list_news');
    expect(paths(transport)).toEqual(['/api/articles?page=1']);
    expect(payload(result)).toMatchObject({ items: [{ id: 7001, title: 'Quarterly update' }], next_page: 2 });
  });
  it('routes space news and featured', async () => {
    let r = await call({ '/api/spaces/30/news': fx.articleList }, 'workvivo_list_news', { space_id: 30, page: 3 });
    expect(paths(r.transport)).toEqual(['/api/spaces/30/news?page=3&type=published']);
    await h!.harness.close();
    r = await call({ '/api/articles/featured': fx.articleList.data }, 'workvivo_list_news', { featured: true });
    expect(paths(r.transport)).toEqual(['/api/articles/featured']);
    expect(payload(r.result)).toMatchObject({ items: [{ id: 7001 }] });
  });
  it('reads an article body as text', async () => {
    const { result } = await call({ '/api/articles/7001': fx.article }, 'workvivo_get_article', { article_id: 7001 });
    const p = payload(result);
    expect(p.body).toMatch(/We shipped/);
    expect(p).not.toHaveProperty('html_content');
  });
  it('reads an article body as Markdown with body_format', async () => {
    const { result } = await call({ '/api/articles/7001': fx.article }, 'workvivo_get_article', { article_id: 7001, body_format: 'markdown' });
    expect(payload(result).body).toBe('## Highlights\n\nWe shipped **three** things.\n\n- One\n- Two');
  });
});

describe('posts and comments', () => {
  it('reads an update or a kudos from the right endpoint', async () => {
    let r = await call({ '/api/updates/5001': fx.updateActivity.item }, 'workvivo_get_post', { type: 'update', id: 5001 });
    expect(paths(r.transport)).toEqual(['/api/updates/5001']);
    expect(payload(r.result)).toMatchObject({ type: 'update', by: 'Alice Example' });
    await h!.harness.close();
    r = await call({ '/api/kudos/6001': fx.kudosActivity.item }, 'workvivo_get_post', { type: 'kudos', id: 6001 });
    expect(paths(r.transport)).toEqual(['/api/kudos/6001']);
    expect(payload(r.result)).toMatchObject({ type: 'kudos', to: ['Bob Sample'] });
  });

  it('lists shoutouts', async () => {
    const { result } = await call({ '/api/kudos': { data: [fx.kudosActivity.item], next_page_url: null } }, 'workvivo_list_shoutouts');
    expect(payload(result)).toEqual(expect.objectContaining({ items: [expect.objectContaining({ by: 'Alice Example', to: ['Bob Sample'] })] }));
  });

  it('resolves commenter names, tolerating a missing profile', async () => {
    const { result, transport } = await call(
      {
        '/api/comments/article/7001': fx.comments,
        '/api/people/101': fx.alice,
        '/api/people/102': fx.bob,
        '/api/people/103': { status: 404, body: '{"message":""}' },
      },
      'workvivo_get_comments',
      { type: 'article', id: 7001 },
    );
    const p = payload(result) as { comments: Array<Record<string, unknown>> };
    expect(p.comments.map((c) => c.by)).toEqual(['Alice Example', 'Bob Sample', undefined]);
    expect(p.comments[2]!.user_id).toBe(103);
    expect(paths(transport)[0]).toBe('/api/comments/article/7001');
  });

  it('full comments skip the name lookups', async () => {
    const { transport } = await call({ '/api/comments/update/5001': fx.comments }, 'workvivo_get_comments', { type: 'update', id: 5001, view: 'full' });
    expect(paths(transport)).toEqual(['/api/comments/update/5001']);
  });
});

describe('events', () => {
  it('lists events (all, or a space\'s)', async () => {
    let r = await call({ '/api/events/listings': { data: [fx.event], next_page_url: null } }, 'workvivo_list_events');
    expect(paths(r.transport)).toEqual(['/api/events/listings?page=1']);
    expect(payload(r.result)).toMatchObject({ items: [{ id: 8001, starts: '2026-11-11T18:00:00Z' }] });
    await h!.harness.close();
    r = await call({ '/api/spaces/30/events': { data: [], next_page_url: null } }, 'workvivo_list_events', { space_id: 30 });
    expect(paths(r.transport)).toEqual(['/api/spaces/30/events?page=1']);
  });

  it('reads events/show/<id> and redacts the meeting password on EVERY rung', async () => {
    for (const view of ['compact', 'full']) {
      const { result, transport } = await call({ '/api/events/show/8001': fx.event }, 'workvivo_get_event', { event_id: 8001, view });
      expect(paths(transport)).toEqual(['/api/events/show/8001']);
      expect(textOf(result)).not.toContain('hunter2-synthetic');
      await h!.harness.close();
      h = undefined;
    }
  });
});

describe('people', () => {
  it('searches the directory', async () => {
    const { result, transport } = await call(
      { '/api/people': { all: 18000, data: [fx.alice], next_page_url: 'https://h/api/people?page=2' } },
      'workvivo_search_people',
      { query: 'alice' },
    );
    expect(paths(transport)).toEqual(['/api/people?page=1&query=alice&includeExternal=true']);
    expect(payload(result)).toEqual(expect.objectContaining({ directory_total: 18000, next_page: 2, people: [expect.objectContaining({ name: 'Alice Example' })] }));
  });
  it('reads a person, me, and my team', async () => {
    let r = await call({ '/api/people/101': fx.personDetail }, 'workvivo_get_person', { person_id: 101 });
    expect(payload(r.result)).toMatchObject({ name: 'Alice Example', manager: { name: 'Bob Sample' } });
    await h!.harness.close();
    r = await call({ '/api/user': fx.me }, 'workvivo_get_me');
    expect(textOf(r.result)).not.toMatch(/rt-synthetic|amp-synthetic/);
    await h!.harness.close();
    r = await call({ '/api/user': fx.me }, 'workvivo_get_me', { view: 'full' });
    expect(textOf(r.result)).not.toMatch(/rt-synthetic|amp-synthetic/);
    await h!.harness.close();
    r = await call({ '/api/people/my/team': [fx.alice, fx.bob] }, 'workvivo_get_my_team');
    expect((payload(r.result) as { people: unknown[] }).people).toHaveLength(2);
  });
});

describe('spaces', () => {
  it.each([
    [{}, '/api/spaces?page=1&type=my&pageSize=50'],
    [{ scope: 'all', page: 2 }, '/api/spaces?page=2'],
    [{ query: 'office', scope: 'all' }, '/api/spaces?page=1&type=search&query=office'],
  ])('lists %j → %s', async (args, expected) => {
    const { result, transport } = await call({ '/api/spaces': fx.spaceList }, 'workvivo_list_spaces', args);
    expect(paths(transport)).toEqual([expected]);
    expect(payload(result)).toMatchObject({ items: [{ id: 30, name: 'Company News' }] });
  });
  it('lists trending (single page) and reads one space', async () => {
    let r = await call({ '/api/spaces/trending': fx.spaceList.data }, 'workvivo_list_spaces', { scope: 'trending' });
    expect(payload(r.result)).toMatchObject({ items: [{ id: 30 }] });
    await h!.harness.close();
    r = await call({}, 'workvivo_list_spaces', { scope: 'trending', page: 2 });
    expect((r.result as { isError?: boolean }).isError).toBe(true);
    await h!.harness.close();
    r = await call({ '/api/spaces/30': fx.spaceList.data[0] }, 'workvivo_get_space', { space_id: 30 });
    expect(paths(r.transport)).toEqual(['/api/spaces/30?info=1']);
  });
});

describe('notifications', () => {
  it('page 1 carries unread counts', async () => {
    const { result, transport } = await call(
      { '/api/notifications': fx.notifications, '/api/notifications/unread': { notifications: 9, pulse: 0, chat: 0 } },
      'workvivo_list_notifications',
    );
    expect(paths(transport).sort()).toEqual(['/api/notifications/unread', '/api/notifications?page=1']);
    expect(payload(result)).toMatchObject({ unread: { notifications: 9 }, items: [{ kind: 'ArticlePublishedNotification', read: false }] });
  });
  it('later pages skip the counts', async () => {
    const { result, transport } = await call({ '/api/notifications': fx.notifications }, 'workvivo_list_notifications', { page: 2 });
    expect(paths(transport)).toEqual(['/api/notifications?page=2']);
    expect(payload(result)).not.toHaveProperty('unread');
  });
});

describe('workvivo_search', () => {
  it('posts query + default types and strips highlight markup', async () => {
    const { result, transport } = await call({ '/api/federated-search': fx.searchResults }, 'workvivo_search', { query: 'update' });
    const call0 = transport.apiCalls[0]!;
    expect(call0.method).toBe('POST');
    const body = JSON.parse(call0.body!);
    expect(body).toMatchObject({ page: 1, query: 'update' });
    expect(body.types).toContain('article');
    expect(payload(result)).toMatchObject({ page: 1, last_page: 3, results: [{ title: 'Quarterly update', id: 7001 }] });
  });
  it('passes explicit types and rejects unknown ones before calling', async () => {
    let r = await call({ '/api/federated-search': fx.searchResults }, 'workvivo_search', { query: 'x', types: ['event'], page: 2 });
    expect(JSON.parse(r.transport.apiCalls[0]!.body!)).toEqual({ page: 2, query: 'x', types: ['event'] });
    await h!.harness.close();
    r = await call({}, 'workvivo_search', { query: 'x', types: ['nope'] });
    expect((r.result as { isError?: boolean }).isError).toBe(true);
    expect(r.transport.apiCalls).toHaveLength(0);
  });
});

describe('workvivo_api_get', () => {
  it('reads a relative path and redacts credentials', async () => {
    const { result, transport } = await call({ '/api/terms/departments': [{ id: 1, name: 'Eng', api_key: 'k' }] }, 'workvivo_api_get', { path: '/api/terms/departments' });
    expect(paths(transport)).toEqual(['/api/terms/departments']);
    expect(textOf(result)).toContain('[redacted]');
    expect(textOf(result)).not.toContain('"k"');
  });

  it.each([
    'https://evil.example.com/x',
    '../etc/passwd',
    'spaces/../user',
    '//evil.example.com',
    'spaces/30/update-last-visited',
    'livestreams-v2/1/download',
    'spaces/30/export/members',
    'a b',
  ])('refuses %s', (p) => {
    expect(() => assertReadPath(p)).toThrow();
  });

  it.each(['terms/departments', 'terms/200/people?page=1', 'search/smith?v2=1', 'likedby/update/1', 'spaces?page=1&type=my'])(
    'allows %s',
    (p) => {
      expect(assertReadPath(p)).toBe(p);
    },
  );
});

describe('errors reach the caller with their hint', () => {
  it('a signed-out browser says how to sign in', async () => {
    const { result } = await call({ '/': { body: '<html></html>' } }, 'workvivo_get_feed');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/Not signed in to Workvivo[\s\S]*https:\/\/acme\.workvivo\.us/);
  });
});
