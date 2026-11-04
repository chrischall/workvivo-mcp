import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor, payload } from './helpers.js';
import * as fx from './fixtures.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4), read off
 * the served `tools/list` — what a host sees. Group: `work`.
 */
const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  workvivo_get_feed: 'whats-new',
  workvivo_list_news: 'whats-new',
  workvivo_get_article: 'lookup',
  workvivo_get_post: 'lookup',
  workvivo_list_shoutouts: 'whats-new',
  workvivo_get_comments: 'lookup',
  workvivo_list_events: 'whats-on',
  workvivo_get_event: 'lookup',
  workvivo_search_people: 'lookup',
  workvivo_get_person: 'lookup',
  workvivo_get_me: 'lookup',
  workvivo_get_my_team: 'lookup',
  workvivo_list_spaces: 'lookup',
  workvivo_get_space: 'lookup',
  workvivo_list_notifications: 'whats-new',
  workvivo_search: 'lookup',
  workvivo_get_question: 'lookup',
  workvivo_list_pages: 'lookup',
  workvivo_get_page: 'lookup',
  workvivo_get_document: 'other',
  workvivo_digest_space: 'lookup',
  workvivo_api_get: 'other',
};

interface Tool {
  name: string;
  _meta?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
}
type Mint = Record<string, unknown>;

let h: Awaited<ReturnType<typeof harnessFor>>;
let tools: Tool[];
const mintOf = (t: Tool) => t._meta?.mint as Mint | undefined;

beforeAll(async () => {
  h = await harnessFor();
  tools = (await h.harness.client.listTools()).tools as unknown as Tool[];
});
afterAll(async () => {
  await h?.harness.close();
});

describe('_meta.mint on tools/list', () => {
  it('hints every served tool except the healthcheck, and names each one here', () => {
    const hinted = tools.filter((t) => !t.name.endsWith('_healthcheck'));
    expect(hinted.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
    expect(tools.filter((t) => !mintOf(t)).map((t) => t.name)).toEqual(['workvivo_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s is in the work group with intent %s', (name, intent) => {
    const mint = mintOf(tools.find((t) => t.name === name)!);
    expect(mint?.domain).toBe('work');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', () => {
    for (const t of tools) {
      const mint = mintOf(t);
      if (!mint) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(mint.intent);
      }
      if ('subject' in mint) expect(props, t.name).toHaveProperty(String(mint.subject));
      if ('when' in mint) {
        const when = mint.when as Record<string, unknown>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(String(when.start));
        expect(props, t.name).toHaveProperty(String(when.end));
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks at most one canonical read per intent: notifications (whats-new) and events (whats-on)', () => {
    const canonical = tools
      .filter((t) => mintOf(t)?.canonical === true)
      .map((t) => [t.name, mintOf(t)!.intent])
      .sort();
    expect(canonical).toEqual([
      ['workvivo_list_events', 'whats-on'],
      ['workvivo_list_notifications', 'whats-new'],
    ]);
    // Nothing in Workvivo answers "what's due"; no subject is listable (spaces
    // are not a person's subjects), so no canonical read names one.
    for (const t of tools.filter((x) => mintOf(x)?.canonical)) expect(mintOf(t)).not.toHaveProperty('subject');
  });

  it('every canonical read offers view: brief', () => {
    for (const t of tools.filter((x) => mintOf(x)?.canonical)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
  });
});

describe('view: brief', () => {
  let b: Awaited<ReturnType<typeof harnessFor>> | undefined;
  afterEach(async () => {
    await b?.harness.close();
    b = undefined;
  });
  const call = async (routes: Record<string, unknown>, name: string, args: Record<string, unknown> = {}) => {
    b = await harnessFor(routes);
    const result = await b.harness.client.callTool({ name, arguments: { view: 'brief', ...args } });
    return { result, transport: b.transport };
  };
  const linesOf = (result: unknown): string[] => {
    const p = payload(result);
    expect(p.untrusted_content).toBe(true);
    expect(String(p.note)).toMatch(/other Workvivo users/);
    expect(Array.isArray(p.data)).toBe(true);
    return p.data as string[];
  };
  const LINE = /^.+ — (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|no date) — .+$/;

  it('notifications: one line per item inside the untrusted envelope, read state as status', async () => {
    const page = {
      current_page: 1,
      data: [
        ...fx.notifications.data,
        { id: 'b2', type: 'App\\Notifications\\MentionNotification', read_at: '2026-11-03 09:00:00', created_at: '2026-11-02 10:00:00', data: { id: 5001, type: 'update' } },
        { id: 'b3', read_at: null, data: { title: 'x'.repeat(300) } },
      ],
      next_page_url: null,
    };
    const { result, transport } = await call({ '/api/notifications': page }, 'workvivo_list_notifications');
    // Brief needs no unread-count call.
    expect(transport.apiCalls.map((c) => c.path)).toEqual(['/api/notifications?page=1']);
    const lines = linesOf(result);
    expect(lines).toEqual([
      'Quarterly update — 2026-11-03T08:00:33Z — unread',
      'MentionNotification — 2026-11-02T10:00:00Z — read',
      expect.stringMatching(/^x+… — no date — unread$/),
    ]);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(120);
      expect(l).toMatch(LINE);
    }
  });

  it('notifications: "-- none" when empty, "-- more" when another page exists', async () => {
    let r = await call({ '/api/notifications': { data: [], next_page_url: null } }, 'workvivo_list_notifications');
    expect(linesOf(r.result)).toEqual(['-- none']);
    await b!.harness.close();
    r = await call(
      { '/api/notifications': { ...fx.notifications, next_page_url: 'https://acme.workvivo.us/api/notifications?page=2' } },
      'workvivo_list_notifications',
    );
    expect(linesOf(r.result)).toEqual(['Quarterly update — 2026-11-03T08:00:33Z — unread', '-- more']);
  });

  it('events: one line per upcoming event with RSVP state; "-- N of M shown" when a total says so', async () => {
    const page = {
      current_page: 1,
      total: 5,
      data: [fx.event, { id: 8002, title: 'Office hours', scheduled_at_utc: '2026-11-12T15:00:00Z', is_going: false }, { id: 8003 }],
      next_page_url: 'https://acme.workvivo.us/api/events/listings?page=2',
    };
    const { result } = await call({ '/api/events/listings': page }, 'workvivo_list_events');
    expect(linesOf(result)).toEqual([
      'Town Hall — 2026-11-11T18:00:00Z — going',
      'Office hours — 2026-11-12T15:00:00Z — not going',
      'Event — no date — no rsvp',
      '-- 3 of 5 shown',
    ]);
  });

  it('events: "-- none" for a space with nothing upcoming', async () => {
    const { result } = await call({ '/api/spaces/30/events': { data: [] } }, 'workvivo_list_events', { space_id: 30 });
    expect(linesOf(result)).toEqual(['-- none']);
  });

  it('escapes a title that starts with "-- " or "\\" with one backslash, so it never reads as a note', async () => {
    const page = {
      data: [
        { id: 'e1', read_at: null, created_at: '2026-11-02 10:00:00', data: { title: '-- none' } },
        { id: 'e2', read_at: null, created_at: '2026-11-02 10:00:00', data: { title: '\\server\\share moved' } },
        { id: 'e3', read_at: null, created_at: '2026-11-02 10:00:00', data: { title: '--no space is fine' } },
      ],
      next_page_url: null,
    };
    const { result } = await call({ '/api/notifications': page }, 'workvivo_list_notifications');
    expect(linesOf(result)).toEqual([
      '\\-- none — 2026-11-02T10:00:00Z — unread',
      '\\\\server\\share moved — 2026-11-02T10:00:00Z — unread',
      '--no space is fine — 2026-11-02T10:00:00Z — unread',
    ]);
  });

  it('cuts each line to 120 chars as a WHOLE, title first, even when the date is not ISO', async () => {
    const page = {
      data: [{ id: 8009, title: 'Long '.repeat(40), scheduled_at_utc: 'sometime '.repeat(20), is_going: true }],
      next_page_url: null,
    };
    const { result } = await call({ '/api/events/listings': page }, 'workvivo_list_events');
    const [l] = linesOf(result);
    expect(l.length).toBeLessThanOrEqual(120);
    expect(l.startsWith('Long')).toBe(true);
    expect(l).toMatch(/ — going$/);
  });

  it('other rungs are unchanged (compact still the default)', async () => {
    b = await harnessFor({ '/api/events/listings': { data: [fx.event], next_page_url: null } });
    const result = await b.harness.client.callTool({ name: 'workvivo_list_events', arguments: {} });
    expect((payload(result) as { items: unknown[] }).items).toHaveLength(1);
  });
});
