import { untrustedEnvelope } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { nextPage } from './project.js';
import { WV_UNTRUSTED_NOTE } from './view.js';

/**
 * The `view: "brief"` rung of a canonical read (mcp-host's context-groups
 * contract): one line per item, at most 120 characters,
 * `title — <ISO date | no date> — <status>`. Lines starting `-- ` are NOTES,
 * not items: `-- none` for an empty result, `-- N of M shown` or `-- more`
 * when the page is partial. Titles are written by other people in the
 * organization, so the lines answer inside the untrusted-data envelope as
 * `data: string[]`, like every other rung of the same tool. A title that
 * starts with `-- ` or `\` is escaped with one leading `\`, so a title
 * someone else wrote can never read as a note (the host strips one backslash
 * from every item line). Each line is cut to ≤ 120 chars as a WHOLE, title
 * first: the title shortens to a floor, then the date gives way — Workvivo
 * dates that are not `YYYY-MM-DD HH:MM:SS` pass through unchanged and can be
 * any length.
 */
export const BRIEF_MAX = 120;

/** The shortest a title is cut to before the date gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0)).trimEnd()}…` : s);

/** Prefix one `\` to a title that would otherwise read as a note (or lose a backslash to the host). */
export const escapeTitle = (t: string): string => (t.startsWith('-- ') || t.startsWith('\\') ? `\\${t}` : t);

export function briefLine(title: string | undefined, date: string | undefined, status: string): string {
  const t = escapeTitle((title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled');
  let when = (date ?? 'no date').replace(/\s+/g, ' ').trim() || 'no date';
  const room = BRIEF_MAX - ` — ${when} — ${status}`.length;
  const shown = cut(t, Math.max(room, Math.min(t.length, TITLE_FLOOR)));
  const dateRoom = BRIEF_MAX - shown.length - ` —  — ${status}`.length;
  if (when.length > dateRoom) when = cut(when, Math.max(dateRoom, 1));
  return cut(`${shown} — ${when} — ${status}`, BRIEF_MAX);
}

type Rec = Record<string, unknown>;

/** The items of a Laravel page (or a bare array). */
export function pageItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const d = (data ?? {}) as Rec;
  return Array.isArray(d.data) ? d.data : [];
}

/** The pagination/emptiness notes for a page that yielded `shown` lines. */
export function pageNotes(data: unknown, shown: number): string[] {
  if (shown === 0) return ['-- none'];
  if (Array.isArray(data) || data === null || typeof data !== 'object') return [];
  const page = data as Rec;
  if (typeof page.total === 'number' && page.total > shown) return [`-- ${shown} of ${page.total} shown`];
  const more = nextPage(page) !== undefined || (typeof page.next_page_url === 'string' && page.next_page_url !== '');
  return more ? ['-- more'] : [];
}

/** A brief answer: item lines then notes, in the untrusted envelope. */
export function briefResult(data: unknown, line: (item: unknown) => string): CallToolResult {
  const lines = pageItems(data).map(line);
  const all = [...lines, ...pageNotes(data, lines.length)];
  return { content: [{ type: 'text', text: JSON.stringify(untrustedEnvelope(all, { note: WV_UNTRUSTED_NOTE })) }] };
}
