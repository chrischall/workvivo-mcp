// Compact projections of Workvivo records, and the redaction every rung gets.
//
// Workvivo's records are fat: a feed page of five posts is ~65 KB, one
// space's news page ~1 MB, and the signed-in user record ~80 KB of org
// configuration. Compact (the default `view`) keeps only the documented
// fields below — each one read off a live response, see
// docs/WORKVIVO-API.md — and derives a few conveniences (UTC ISO times,
// plain text from HTML, author names).
//
// `redactSensitive` runs on EVERY rung, full included: some records carry
// credentials that are not the caller's to relay — events carry
// `zoom_webinar_password`, the user record carries a realtime-events token and
// analytics keys.

import { htmlToText } from '@chrischall/mcp-utils/rich';
import { htmlToMarkdown, lexicalToMarkdown } from './markdown.js';

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 1 || v === 0 ? v === 1 : undefined;

/** Drop keys whose value is undefined, so compact records carry no holes. */
function prune<T extends Rec>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

const SENSITIVE_KEY = /(password|passcode|secret|token|api_?key|_key$|^key$|signature|credential)/i;
// Keys that LOOK sensitive by name but are pagination, not credentials.
const NOT_SENSITIVE = new Set(['next_cursor', 'prev_cursor']);

/** Replace credential-shaped fields anywhere in a value with "[redacted]". */
export function redactSensitive<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRec(v)) return v;
    const out: Rec = {};
    for (const [k, val] of Object.entries(v)) {
      // Only a string or a structure can carry a credential; a boolean/number
      // under a sensitive-looking name is a setting (`allow_otp_password_reset`).
      const carriesValue = (typeof val === 'string' && val !== '') || (typeof val === 'object' && val !== null);
      if (!NOT_SENSITIVE.has(k) && SENSITIVE_KEY.test(k) && carriesValue) {
        out[k] = '[redacted]';
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  };
  return walk(value) as T;
}

/**
 * Workvivo timestamps are UTC in `YYYY-MM-DD HH:MM:SS` form (verified against
 * the `*_utc` twins events carry and against relative "N minutes ago" labels).
 * Return ISO-8601 with a `Z`; pass anything else through unchanged.
 */
export function utcIso(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]00:?00)?$/.exec(s);
  return m ? `${m[1]}T${m[2]}Z` : s;
}

/** A post-like HTML body as plain text, paragraphs and list items kept on their own lines. */
const readableText = (html: string): string => htmlToText(html, { paragraphs: true });

/** Strip search-highlight markup (`<strong>`) and other tags from a short string. */
export function stripTags(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  return readableText(s).trim() || undefined;
}

const MAX_TEXT = 600;

function clip(text: string | undefined, max = MAX_TEXT): { text?: string; text_truncated?: true } {
  if (!text) return {};
  const t = text.trim();
  if (t.length <= max) return { text: t };
  return { text: `${t.slice(0, max).trimEnd()}…`, text_truncated: true };
}

/** The readable text of a post-like item: plain `text`, else its HTML rendered. */
export function itemText(item: Rec): string | undefined {
  return (
    str(item.text) ??
    str(item.body) ??
    (str(item.html) ? readableText(item.html as string) : undefined) ??
    (str(item.html_content) ? readableText(item.html_content as string) : undefined) ??
    str(item.short_text)
  )?.trim();
}

function authorOf(item: Rec): { by?: string; by_id?: number } {
  const a = [item.creator, item.user, item.giver].find(isRec);
  if (!a) return {};
  return prune({ by: str(a.full_name) ?? str(a.display_name), by_id: num(a.id) });
}

const spaceNames = (v: unknown): string[] =>
  arr(v).flatMap((s) => (isRec(s) && str(s.name) ? [s.name as string] : []));

// ---------------------------------------------------------------- people

export function person(p: unknown): Rec {
  if (!isRec(p)) return {};
  return prune({
    id: num(p.id),
    name: str(p.full_name) ?? str(p.display_name),
    job_title: str(p.job_title),
    department: str(p.department_name),
    location: str(p.location_name),
    email: str(p.email),
    is_alumni: bool(p.is_alumni) || undefined,
    is_external: bool(p.is_external) || undefined,
  });
}

export function personDetail(p: unknown): Rec {
  if (!isRec(p)) return {};
  const profile = isRec(p.profile) ? p.profile : {};
  const manager = isRec(p.manager) ? p.manager : undefined;
  return prune({
    ...person(p),
    cost_centre: str(p.cost_centre_name),
    hired: str(p.formatted_hire_date),
    manager: manager ? prune({ id: num(manager.id), name: str(manager.full_name) }) : undefined,
    direct_reports: Array.isArray(p.manages) ? p.manages.length : undefined,
    bio: str(profile.short_bio) ?? str(profile.bio),
    expertise: str(profile.expertise),
    interests: str(profile.interests),
    followers: num(p.followers_count),
    following: num(p.following_count),
    url: str(p.relative_permalink),
  });
}

/** The signed-in user — an allowlist; the raw record is ~80 KB of org config. */
export function me(u: unknown): Rec {
  if (!isRec(u)) return {};
  return prune({
    ...person(u),
    cost_centre: str(u.cost_centre_name),
    hired: str(u.formatted_hire_date),
    timezone: str(u.timezone),
    locale: str(u.locale),
    roles: Array.isArray(u.allRoles) ? u.allRoles.filter((r) => typeof r === 'string') : undefined,
  });
}

// ---------------------------------------------------------------- feed

/** One feed entry (an `activity` row wrapping an update/article/event/…). */
export function feedEntry(a: unknown): Rec {
  if (!isRec(a)) return {};
  const item = isRec(a.item) ? a.item : {};
  const title = str(item.title);
  const text = title ? str(item.subtitle) ?? str(item.short_text) ?? itemText(item) : itemText(item);
  const mentions = arr(item.user_mentions)
    .map((m) => (isRec(m) && isRec(m.user) ? str(m.user.full_name) : undefined))
    .filter((n): n is string => !!n);
  return prune({
    type: str(a.item_type),
    id: num(a.item_id),
    at: utcIso(a.created_at),
    ...authorOf(item),
    to: mentions.length && a.item_type === 'kudos' ? mentions : undefined,
    title,
    ...clip(text),
    starts: a.item_type === 'event' ? utcIso(item.scheduled_at) : undefined,
    comments: num(item.comments_count),
    likes: num(item.likes_count),
    spaces: spaceNames(a.spaces).length ? spaceNames(a.spaces) : undefined,
    pinned: a.pinned_at ? true : undefined,
    url: str(item.relative_permalink),
  });
}

/** A feed page: cursor-paged (`activity`, space feeds) or page-paged (a person's). */
export function feedPage(page: unknown): Rec {
  if (!isRec(page)) return { items: [] };
  return prune({
    items: arr(page.data).map(feedEntry),
    next_cursor: str(page.next_cursor),
    next_page: nextPage(page),
  });
}

/** The next page number from a Laravel paginator, or undefined on the last page. */
export function nextPage(page: Rec): number | undefined {
  const next = str(page.next_page_url) ?? (isRec(page.links) ? str(page.links.next) : undefined);
  if (!next) return undefined;
  const m = /[?&]page=(\d+)/.exec(next);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- lists

/** A Laravel page of records → `{ items, next_page }`; a bare array → `{ items }`. */
export function listOf(project: (r: unknown) => unknown) {
  return (data: unknown): unknown => {
    if (Array.isArray(data)) return { items: data.map(project) };
    const page = (isRec(data) ? data : {}) as Rec;
    const items = Array.isArray(page.data) ? page.data.map(project) : undefined;
    if (!items) return undefined; // not a page — projectOrRaw falls back to the raw value
    const next = nextPage(page);
    return next !== undefined ? { items, next_page: next } : { items };
  };
}

// ---------------------------------------------------------------- news

export function articleSummary(a: unknown): Rec {
  if (!isRec(a)) return {};
  return prune({
    id: num(a.id),
    title: str(a.title),
    subtitle: str(a.subtitle),
    published_at: utcIso(a.published_at),
    ...authorOf(a),
    comments: num(a.comments_count),
    likes: num(a.likes_count),
    spaces: spaceNames(a.spaces).length ? spaceNames(a.spaces) : spaceNames(a.article_spaces).length ? spaceNames(a.article_spaces) : undefined,
    url: num(a.id) !== undefined ? `news/${num(a.id)}` : undefined,
    external_url: str(a.external_url),
  });
}

/** How an article body reads: plain text (the default) or Markdown (headings, lists, links kept). */
export type BodyFormat = 'text' | 'markdown';

export function articleDetail(a: unknown, opts: { bodyFormat?: BodyFormat; origin?: string } = {}): Rec {
  if (!isRec(a)) return {};
  const html = str(a.html_content);
  const body = html
    ? opts.bodyFormat === 'markdown' && opts.origin
      ? htmlToMarkdown(html, opts.origin)
      : readableText(html)
    : itemText(a);
  return prune({
    ...articleSummary(a),
    url: str(a.permalink) ?? articleSummary(a).url,
    body,
  });
}

// ---------------------------------------------------------------- posts

/** An update (a post) or a kudos (shoutout). */
export function post(p: unknown, type: string): Rec {
  if (!isRec(p)) return {};
  const mentions = arr(p.user_mentions)
    .map((m) => (isRec(m) && isRec(m.user) ? str(m.user.full_name) : undefined))
    .filter((n): n is string => !!n);
  const activity = arr(p.activity).find(isRec);
  return prune({
    type,
    id: num(p.id),
    at: utcIso(p.created_at),
    ...authorOf(p),
    to: type === 'kudos' && mentions.length ? mentions : undefined,
    mentions: type !== 'kudos' && mentions.length ? mentions : undefined,
    text: itemText(p),
    comments: num(p.comments_count),
    likes: num(p.likes_count),
    spaces: activity ? (spaceNames(activity.spaces).length ? spaceNames(activity.spaces) : undefined) : undefined,
    url: str(p.relative_permalink),
  });
}

export function comment(c: unknown, names: Map<number, string>): Rec {
  if (!isRec(c)) return {};
  const uid = num(c.user_id);
  return prune({
    id: num(c.id),
    reply_to: num(c.parent_comment_id),
    user_id: uid,
    by: uid !== undefined ? names.get(uid) : undefined,
    at: utcIso(c.created_at),
    text: itemText(c),
    likes: num(c.likes_count),
  });
}

// ---------------------------------------------------------------- Q&A

/** A question post (Q&A). Answers come from a separate endpoint. */
export function question(q: unknown): Rec {
  if (!isRec(q)) return {};
  const accepted = isRec(q.accepted_answer) ? num(q.accepted_answer.id) : undefined;
  return prune({
    id: num(q.id),
    title: str(q.title),
    text: str(q.body) ? readableText(q.body as string) : itemText(q),
    at: utcIso(q.created_at),
    ...authorOf(q),
    answered: bool(q.answered),
    answers_count: num(q.answers_count),
    accepted_answer_id: accepted,
    votes: num(q.votes),
    views: num(q.views_count),
    spaces: spaceNames(q.spaces).length ? spaceNames(q.spaces) : undefined,
    url: str(q.relative_permalink),
  });
}

export function answer(a: unknown): Rec {
  if (!isRec(a)) return {};
  return prune({
    id: num(a.id),
    at: utcIso(a.created_at),
    ...authorOf(a),
    text: str(a.body) ? readableText(a.body as string) : itemText(a),
    accepted: bool(a.accepted) || undefined,
    votes: num(a.votes),
    comments: num(a.comments_count),
  });
}

// ---------------------------------------------------------------- events

export function event(e: unknown, opts: { detail?: boolean } = {}): Rec {
  if (!isRec(e)) return {};
  const spaces = spaceNames(e.spaces).length ? spaceNames(e.spaces) : spaceNames(e.event_spaces);
  const text = itemText(e) ?? (str(e.html_content) ? readableText(e.html_content as string) : undefined);
  return prune({
    id: num(e.id),
    title: str(e.title),
    starts: utcIso(e.scheduled_at_utc) ?? utcIso(e.scheduled_at),
    ends: utcIso(e.ends_at_utc) ?? utcIso(e.ends_at),
    all_day: bool(e.all_day_event),
    location: str(e.location),
    going_count: num(e.going_count),
    is_going: bool(e.is_going),
    ...authorOf(e),
    spaces: spaces.length ? spaces : undefined,
    ...(opts.detail ? { text } : clip(text, 300)),
    rsvp_url: opts.detail ? str(e.book_button_url) : undefined,
    url: num(e.id) !== undefined ? `events/${num(e.id)}` : undefined,
  });
}

// ---------------------------------------------------------------- spaces

export function space(s: unknown, opts: { detail?: boolean } = {}): Rec {
  if (!isRec(s)) return {};
  const description = str(s.description);
  return prune({
    id: num(s.id),
    name: str(s.name),
    ...(opts.detail ? { description } : { description: description && description.length > 200 ? `${description.slice(0, 200)}…` : description }),
    members: num(s.members_count) ?? num(s.users_count),
    is_member: bool(s.is_member),
    official: bool(s.is_official) || undefined,
    private: bool(s.private) || undefined,
    parent_space_id: num(s.parent_space_id),
    last_activity: opts.detail ? utcIso(s.last_activity) : undefined,
    url: str(s.relative_permalink),
  });
}

// ---------------------------------------------------------------- notifications

export function notification(n: unknown): Rec {
  if (!isRec(n)) return {};
  const data = isRec(n.data) ? n.data : {};
  return prune({
    id: str(n.id) ?? num(n.id),
    read: n.read_at !== null && n.read_at !== undefined,
    at: utcIso(n.created_at),
    kind: str(n.type)?.replace(/^App\\Notifications\\/, ''),
    title: str(data.title),
    item_type: str(data.type),
    item_id: num(data.id),
  });
}

// ---------------------------------------------------------------- search

export function searchHit(h: unknown): Rec {
  if (!isRec(h)) return {};
  const details = isRec(h.details) ? h.details : {};
  const snippet = stripTags(details.text);
  return prune({
    type: str(h.type),
    id: num(h.id) ?? str(h.id),
    title: stripTags(h.title),
    url: str(h.url),
    updated_at: utcIso(h.updated_at),
    by: str(details.author),
    ...(snippet ? clip(snippet, 300) : {}),
  });
}

// ---------------------------------------------------------------- pages

export interface PageNode {
  id?: number;
  title?: string;
  slug?: string;
  draft?: true;
  children?: PageNode[];
}

/** A pages-v2 tree → `{id, title, slug, children}` nodes (drafts flagged). */
export function pageTree(nodes: unknown): PageNode[] {
  return arr(nodes).flatMap((n) => {
    if (!isRec(n)) return [];
    const kids = pageTree(n.children);
    return [
      prune({
        id: num(n.id),
        title: str(n.title),
        slug: str(n.slug),
        draft: n.is_draft === true ? (true as const) : undefined,
        children: kids.length ? kids : undefined,
      }) as PageNode,
    ];
  });
}

/** Flatten a tree, depth-first, keeping each node's depth. */
export function flattenTree(nodes: PageNode[], depth = 0): Array<PageNode & { depth: number }> {
  return nodes.flatMap((n) => [{ ...n, depth }, ...flattenTree(n.children ?? [], depth + 1)]);
}

/** A page's body as Markdown, whichever editor wrote it. */
export function pageMarkdown(page: unknown, origin: string): string {
  if (!isRec(page)) return '';
  const lexical = str(page.json_content);
  const html = str(page.html_content);
  if (page.editor_type === 'lexical' && lexical) return lexicalToMarkdown(lexical, origin);
  if (html) return htmlToMarkdown(html, origin);
  if (lexical) return lexicalToMarkdown(lexical, origin);
  return '';
}

/** Page metadata for the front matter / JSON view. */
export function pageMeta(page: unknown, origin: string): Rec {
  if (!isRec(page)) return {};
  const id = num(page.id);
  const slug = str(page.slug);
  const space = num(page.space_id);
  const group = num(page.page_group_id);
  const url = slug ? (group ? `${origin}/pages/${group}/${slug}` : space ? `${origin}/spaces/${space}/pages/${slug}` : undefined) : undefined;
  return prune({
    id,
    title: str(page.title),
    subtitle: str(page.subtitle),
    slug,
    space_id: space,
    page_group_id: group,
    parent_id: num(page.parent_id),
    editor: str(page.editor_type),
    updated_at: utcIso(page.updated_at),
    draft: page.is_draft === true ? true : undefined,
    url,
  });
}
