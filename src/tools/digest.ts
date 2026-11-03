import type { McpServer } from '@modelcontextprotocol/server';
import { mapWithConcurrency, messageOf, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { extractDocument } from '../documents.js';
import { extractLinks, htmlToMarkdown, isSignedUrl, rebaseHeadings, type ExtractedLink } from '../markdown.js';
import { event, feedEntry, flattenTree, pageMarkdown, pageTree, space, type PageNode } from '../project.js';
import { markdownResult, untrustedDescription } from '../view.js';
import { idArg } from './common.js';

type Rec = Record<string, unknown>;

/** Run one section; a failure becomes a note in the digest instead of failing the whole call. */
async function section<T>(fn: () => Promise<T>): Promise<{ ok: T } | { error: string }> {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { error: messageOf(e) };
  }
}

const failed = (what: string, error: string) => `_(Could not read ${what}: ${error})_`;

export function registerDigestTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_digest_space',
    {
      title: 'Digest a whole Workvivo space',
      description: untrustedDescription(
        'Read an entire Workvivo space in one call and return it as one Markdown document: the space\'s details, ' +
          'its page tree, EVERY page\'s full content as Markdown, an index of every document and link those pages ' +
          'point to (with the document_id for workvivo_get_document), the space\'s document library and useful ' +
          'links, upcoming events, and its most recent posts. Set `include_documents: true` to also download and ' +
          'extract the text of the linked documents (capped by `max_documents`/`max_document_chars`; the browser ' +
          'saves them in its download folder on this machine). Edits nothing in Workvivo (opening documents may be recorded as views, as in the browser).',
      ),
      annotations: toolAnnotations({
        title: 'Digest a whole Workvivo space',
        readOnly: false, // include_documents saves files locally
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        space_id: idArg('space'),
        feed_items: z.coerce.number().int().min(0).max(100).optional().describe('Recent posts to include (default 10).'),
        include_documents: z.boolean().optional().describe('Also download and extract linked documents (default false).'),
        include_translations: z
          .boolean()
          .optional()
          .describe('With include_documents, also extract the language variants linked as "ES"/"PT"/"FR" (default false).'),
        max_documents: z.coerce.number().int().min(1).max(200).optional().describe('Documents to extract when include_documents (default 10).'),
        max_document_chars: z.coerce
          .number()
          .int()
          .min(500)
          .max(50_000)
          .optional()
          .describe('Characters kept per extracted document (default 4000).'),
      }),
    },
    async ({ space_id, feed_items, include_documents, include_translations, max_documents, max_document_chars }) => {
      const origin = client.origin;
      const info = (await client.get<Rec>(`spaces/${space_id}`, { info: 1 })) ?? {};
      const s = space(info, { detail: true });
      const enabled = Object.entries(info)
        .filter(([k, v]) => k.startsWith('enable_') && (v === true || v === 1))
        .map(([k]) => k.slice('enable_'.length));
      const out: string[] = [];
      out.push(`# ${String(s.name ?? `Space ${space_id}`)}`);
      if (typeof s.description === 'string') out.push(s.description);
      out.push(
        [
          `- Members: ${s.members ?? '?'}${s.is_member ? ' (you are a member)' : ''}${s.private ? ' · private' : ''}${s.official ? ' · official' : ''}`,
          `- Sections enabled: ${enabled.join(', ') || 'none'}`,
          `- Default landing: ${String(info.default_landing_page ?? 'feed')}`,
          `- URL: ${origin}/spaces/${space_id}`,
        ].join('\n'),
      );

      // ---- pages: tree + every page as Markdown
      const allLinks: Array<ExtractedLink & { on_page: string }> = [];
      const tree = await section(async () => pageTree((await client.getPageTree({ space_id })).pages));
      let pageCount = 0;
      if ('error' in tree) {
        out.push('## Pages', failed('the page tree', tree.error));
      } else if (tree.ok.length) {
        const flat = flattenTree(tree.ok);
        pageCount = flat.length;
        out.push(
          '## Page tree',
          flat.map((p) => `${'  '.repeat(p.depth)}- ${p.title ?? p.slug} (id ${p.id}, slug "${p.slug}")${p.draft ? ' [draft]' : ''}`).join('\n'),
        );
        const bodies = await mapWithConcurrency(flat, 4, async (p: PageNode & { depth: number }) => {
          const r = await section(async () => {
            const data = await client.getPage({ space_id }, p.slug ?? p.id);
            return pageMarkdown((data.page ?? data) as Rec, origin);
          });
          return { p, r };
        });
        out.push('## Pages');
        for (const { p, r } of bodies) {
          const title = p.title ?? p.slug ?? String(p.id);
          out.push(`### ${title}\n\n_page id ${p.id} · slug "${p.slug}" · ${origin}/spaces/${space_id}/pages/${p.slug}_`);
          if ('error' in r) {
            out.push(failed(`page "${title}"`, r.error));
            continue;
          }
          out.push(r.ok ? rebaseHeadings(r.ok, 4) : '_(empty page)_');
          for (const l of extractLinks(r.ok, origin)) allLinks.push({ ...l, on_page: title });
        }
      }

      // ---- link index across all pages
      const docs = new Map<number, ExtractedLink & { on_pages: Set<string> }>();
      const pagesLinked = new Map<string, ExtractedLink>();
      const external = new Map<string, ExtractedLink>();
      for (const l of allLinks) {
        if (l.kind === 'document' && l.document_id !== undefined) {
          const d = docs.get(l.document_id) ?? { ...l, on_pages: new Set<string>() };
          d.on_pages.add(l.on_page);
          docs.set(l.document_id, d);
        } else if (l.kind === 'page') pagesLinked.set(l.url, l);
        else external.set(l.url, l);
      }
      const label = (l: ExtractedLink) => (l.context && l.context !== l.text ? `${l.text} — ${l.context}` : l.text || l.url);
      if (docs.size) {
        out.push(
          `## Documents linked from the pages (${docs.size})`,
          '| document_id | Link | On page |\n| --- | --- | --- |\n' +
            [...docs.values()]
              .map((d) => `| ${d.document_id} | ${label(d).replace(/\|/g, '\\|')} | ${[...d.on_pages].join('; ').replace(/\|/g, '\\|')} |`)
              .join('\n'),
        );
      }
      if (pagesLinked.size) {
        out.push(
          '## Pages linked from the pages',
          [...pagesLinked.values()]
            .map((l) => `- ${label(l)} — ${l.space_id !== undefined ? `space_id=${l.space_id}` : `page_group_id=${l.page_group_id}`} page="${l.page}"`)
            .join('\n'),
        );
      }
      if (external.size) {
        out.push('## Other links', [...external.values()].map((l) => `- [${label(l)}](${l.url})`).join('\n'));
      }

      // ---- document library + useful links
      const lib = await section(() => client.get<Rec>(`spaces/${space_id}/documents`, { page: 1 }));
      if ('error' in lib) out.push('## Document library', failed('the document library', lib.error));
      else {
        const items = Array.isArray(lib.ok?.data) ? (lib.ok.data as Rec[]) : [];
        if (items.length) {
          out.push(
            `## Document library${lib.ok?.next_page_url ? ' (first page)' : ''}`,
            items
              .map((d) => {
                const name = String(d.title ?? d.name ?? d.label ?? d.id);
                // A library item's url may be a signed file link: never emit one.
                const url = typeof d.url === 'string' && !isSignedUrl(d.url) ? d.url : undefined;
                return `- ${name} (id ${String(d.id)})${url ? ` — ${url}` : ''}`;
              })
              .join('\n'),
          );
        }
      }
      const useful = await section(() => client.get<Rec>(`spaces/${space_id}/links`));
      if ('ok' in useful && typeof useful.ok?.body === 'string' && useful.ok.body.trim()) {
        out.push(`## ${String(useful.ok.title ?? 'Useful links')}`, htmlToMarkdown(useful.ok.body, origin));
      }

      // ---- events
      const ev = await section(() => client.get<Rec>(`spaces/${space_id}/events`, { page: 1 }));
      if ('error' in ev) out.push('## Upcoming events', failed('events', ev.error));
      else {
        const items = (Array.isArray(ev.ok?.data) ? ev.ok.data : []).map((e) => event(e));
        out.push(
          '## Upcoming events',
          items.length
            ? items.map((e) => `- **${String(e.title)}** — ${String(e.starts ?? '?')}${e.location ? ` · ${String(e.location)}` : ''} (event_id ${String(e.id)})`).join('\n')
            : '_None._',
        );
      }

      // ---- recent posts
      const want = feed_items ?? 10;
      if (want > 0) {
        const posts = await section(async () => {
          const items: Rec[] = [];
          let cursor: string | undefined;
          while (items.length < want) {
            const page = (await client.get<Rec>(`spaces/${space_id}/feed`, { next_cursor: cursor })) ?? {};
            const data = Array.isArray(page.data) ? (page.data as Rec[]) : [];
            items.push(...data);
            cursor = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
            if (!cursor || !data.length) break;
          }
          return items.slice(0, want).map(feedEntry);
        });
        if ('error' in posts) out.push('## Recent posts', failed('the feed', posts.error));
        else {
          out.push(
            `## Recent posts (${posts.ok.length})`,
            posts.ok.length
              ? posts.ok
                  .map((p) => {
                    const head = `- **${String(p.title ?? p.type)}** — ${String(p.by ?? '?')}, ${String(p.at ?? '?')} (${String(p.type)} ${String(p.id)})`;
                    const body = typeof p.text === 'string' ? `\n  ${p.text.replace(/\n+/g, ' ')}` : '';
                    return head + body;
                  })
                  .join('\n')
              : '_None._',
          );
        }
      }

      // ---- optional: document contents
      let extracted = 0;
      if (include_documents && docs.size) {
        const cap = max_documents ?? 10;
        const perDoc = max_document_chars ?? 4000;
        // A link labelled only with a language code ("ES") is a translation of
        // the document before it; skip those unless asked.
        const isTranslation = (d: ExtractedLink) => /^[A-Z]{2}(?:-[A-Z]{2})?$/.test(d.text);
        const pool = [...docs.values()].filter((d) => include_translations || !isTranslation(d));
        const targets = pool.slice(0, cap);
        const results = await mapWithConcurrency(targets, 2, async (d) => {
          const r = await section(async () => {
            const file = await client.downloadDocument({ kind: 'document', id: d.document_id! });
            return extractDocument(file.path, file.mime, origin);
          });
          return { d, r };
        });
        const skipped = docs.size - pool.length;
        out.push(`## Document contents (${targets.length} of ${pool.length}${skipped ? `; ${skipped} translations skipped` : ''})`);
        for (const { d, r } of results) {
          out.push(`### ${label(d)}\n\n_document_id ${d.document_id}_`);
          if ('error' in r) out.push(failed('this document', r.error));
          else if (!r.ok.text) out.push(`_${r.ok.note ?? 'No text.'}_`);
          else {
            extracted++;
            const t = r.ok.text.length > perDoc ? `${r.ok.text.slice(0, perDoc).trimEnd()}\n\n_(…truncated; workvivo_get_document document_id=${d.document_id} for the rest)_` : r.ok.text;
            out.push(rebaseHeadings(t, 4));
          }
        }
        if (pool.length > cap) out.push(`_${pool.length - cap} more documents not extracted — raise max_documents or read them with workvivo_get_document._`);
      }

      return markdownResult(
        {
          space_id,
          name: s.name,
          pages: pageCount,
          documents_linked: docs.size,
          documents_extracted: include_documents ? extracted : undefined,
          url: `${origin}/spaces/${space_id}`,
        },
        out.join('\n\n'),
      );
    },
  );
}
