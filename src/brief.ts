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
 * `data: string[]`, like every other rung of the same tool.
 */
export const BRIEF_MAX = 120;

export function briefLine(title: string | undefined, date: string | undefined, status: string): string {
  const when = date ?? 'no date';
  const tail = ` — ${when} — ${status}`;
  const t = (title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled';
  const room = BRIEF_MAX - tail.length;
  return (t.length > room ? `${t.slice(0, room - 1).trimEnd()}…` : t) + tail;
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
