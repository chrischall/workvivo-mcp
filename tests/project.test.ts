import { describe, expect, it } from 'vitest';
import {
  articleDetail,
  articleSummary,
  comment,
  event,
  feedEntry,
  feedPage,
  itemText,
  me,
  nextPage,
  notification,
  personDetail,
  redactSensitive,
  searchHit,
  space,
  stripTags,
  utcIso,
} from '../src/project.js';
import * as fx from './fixtures.js';

describe('redactSensitive', () => {
  it('redacts credential-shaped keys at any depth and keeps pagination cursors', () => {
    const out = redactSensitive({
      next_cursor: 'abc',
      zoom_webinar_password: 'p',
      nested: [{ realtimeEventsToken: { token: 'x' }, amplitude_key: 'k', name: 'keep' }],
      empty_password: '',
      allow_otp_password_reset: false,
      password_age: 90,
    });
    expect(out).toEqual({
      next_cursor: 'abc',
      zoom_webinar_password: '[redacted]',
      nested: [{ realtimeEventsToken: '[redacted]', amplitude_key: '[redacted]', name: 'keep' }],
      empty_password: '',
      allow_otp_password_reset: false,
      password_age: 90,
    });
  });
});

describe('utcIso / stripTags / itemText', () => {
  it('turns Workvivo UTC stamps into ISO-8601 Z', () => {
    expect(utcIso('2026-11-03 14:15:54')).toBe('2026-11-03T14:15:54Z');
    expect(utcIso('2026-11-03T20:00:00Z')).toBe('2026-11-03T20:00:00Z');
    expect(utcIso('2026-10-19T21:08:20.000000Z')).toBe('2026-10-19T21:08:20Z');
    expect(utcIso('yesterday')).toBe('yesterday');
    expect(utcIso(null)).toBeUndefined();
  });
  it('strips highlight markup', () => {
    expect(stripTags('Quarterly <strong>update</strong>')).toBe('Quarterly update');
    expect(stripTags('')).toBeUndefined();
  });
  it('prefers plain text, then renders HTML', () => {
    expect(itemText({ text: 'plain', html: '<p>x</p>' })).toBe('plain');
    expect(itemText({ html: '<p>one</p><p>two</p>' })).toMatch(/one\s+two/);
    expect(itemText({})).toBeUndefined();
  });
});

describe('feed projection', () => {
  it('projects every item type with author, UTC time and url', () => {
    const page = feedPage(fx.feed) as { items: Record<string, unknown>[]; next_cursor: string };
    expect(page.next_cursor).toBe('eyJjdXJzb3IiOjF9');
    const [u, a, e, k] = page.items;
    expect(u).toMatchObject({ type: 'update', id: 5001, at: '2026-11-03T14:15:54Z', by: 'Alice Example', by_id: 101, comments: 2, likes: 7, url: 'comments/update/5001' });
    expect(u!.text).toContain('Proud of the team');
    expect(a).toMatchObject({ type: 'article', title: 'Quarterly update', text: 'What we shipped', pinned: true, spaces: ['Company News'] });
    expect(e).toMatchObject({ type: 'event', title: 'Town Hall', starts: '2026-11-11T18:00:00Z', by: 'Comms Team' });
    expect(k).toMatchObject({ type: 'kudos', by: 'Alice Example', to: ['Bob Sample'] });
    expect(JSON.stringify(page)).not.toContain('avatar_url');
  });
  it('clips long text and says so', () => {
    const long = { ...fx.updateActivity, item: { ...fx.updateActivity.item, text: 'x'.repeat(2000) } };
    const out = feedEntry(long);
    expect(out.text_truncated).toBe(true);
    expect((out.text as string).length).toBeLessThan(700);
  });
  it('reads a page-paged (person) feed', () => {
    expect(feedPage({ data: [], next_page_url: 'https://h/api/people/1/feed?page=3' })).toEqual({ items: [], next_page: 3 });
    expect(nextPage({ next_page_url: null })).toBeUndefined();
    expect(nextPage({ links: { next: 'x?page=2' } })).toBe(2);
  });
});

describe('records', () => {
  it('article summary and detail (body as text, no language variants)', () => {
    expect(articleSummary(fx.articleList.data[0])).toEqual({
      id: 7001,
      title: 'Quarterly update',
      subtitle: 'What we shipped',
      published_at: '2026-10-27T14:15:00Z',
      by: 'Comms Team',
      by_id: 900,
      comments: 4,
      likes: 9,
      spaces: ['Company News'],
      url: 'news/7001',
    });
    const d = articleDetail(fx.article);
    expect(d.url).toBe('https://acme.workvivo.us/news/7001');
    expect(d.body).toMatch(/Highlights[\s\S]*three[\s\S]*One/);
    expect(JSON.stringify(d)).not.toContain('<p>');
    expect(d).not.toHaveProperty('language_variants');
  });

  it('event — UTC times, no meeting secrets in compact', () => {
    const e = event(fx.event, { detail: true });
    expect(e).toMatchObject({ starts: '2026-11-11T18:00:00Z', ends: '2026-11-11T18:30:00Z', going_count: 12, is_going: true, rsvp_url: 'https://example.com/rsvp', url: 'events/8001' });
    expect(JSON.stringify(e)).not.toContain('hunter2');
  });

  it('person detail keeps role/org, drops phone and birthday', () => {
    const p = personDetail(fx.personDetail);
    expect(p).toMatchObject({ name: 'Alice Example', manager: { id: 102, name: 'Bob Sample' }, direct_reports: 2, bio: 'Builds things.', followers: 62 });
    expect(JSON.stringify(p)).not.toMatch(/555|1990/);
  });

  it('me is an allowlist — no tokens, no org config', () => {
    const m = me(fx.me);
    expect(m).toMatchObject({ name: 'Alice Example', timezone: 'America/New_York', roles: ['employee'] });
    expect(JSON.stringify(m)).not.toMatch(/rt-synthetic|amp-synthetic|settings/);
  });

  it('space, notification, comment, search hit', () => {
    expect(space(fx.spaceList.data[0])).toEqual({ id: 30, name: 'Company News', description: 'Your trusted source for updates.', members: 18000, is_member: true, official: true, url: 'spaces/30' });
    expect(notification(fx.notifications.data[0])).toEqual({ id: 'a322aa6a-0000-0000-0000-000000000000', read: false, at: '2026-11-03T08:00:33Z', kind: 'ArticlePublishedNotification', title: 'Quarterly update', item_type: 'news', item_id: 7001 });
    expect(comment(fx.comments[1], new Map([[102, 'Bob Sample']]))).toEqual({ id: 2, reply_to: 1, user_id: 102, by: 'Bob Sample', at: '2026-10-21T09:00:00Z', text: 'Agreed', likes: 0 });
    expect(searchHit(fx.searchResults.data[0])).toEqual({ type: 'article', id: 7001, title: 'Quarterly update', url: 'news/7001', updated_at: '2026-10-19T21:08:20Z', by: 'Comms Team', text: 'We shipped three things' });
  });

  it('non-records project to empty objects', () => {
    for (const f of [feedEntry, articleSummary, articleDetail, personDetail, me, notification, searchHit]) {
      expect(f(null as unknown as never)).toEqual({});
    }
  });
});
