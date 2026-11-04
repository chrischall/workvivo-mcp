import type { McpServer } from '@modelcontextprotocol/server';
import { untrustedResult } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { WorkvivoApiError, type PageScope, type WorkvivoClient } from '../client.js';
import { extractLinks, rebaseHeadings, type ExtractedLink } from '../markdown.js';
import { pageMarkdown, pageMeta, pageTree, flattenTree, redactSensitive } from '../project.js';
import { markdownResult, untrustedDescription, WV_UNTRUSTED_NOTE } from '../view.js';
import { idArg, readAnnotations } from './common.js';
import { LOOKUP } from './hints.js';

const scopeArgs = {
  space_id: idArg('space').optional().describe('The space whose pages to read (from a `spaces/<id>/pages/…` URL).'),
  page_group_id: idArg('page collection')
    .optional()
    .describe('A global page collection instead of a space (from a `pages/<group>/<slug>` URL).'),
};

export function scopeOf(args: { space_id?: number; page_group_id?: number }): PageScope {
  if ((args.space_id === undefined) === (args.page_group_id === undefined)) {
    throw new WorkvivoApiError('Pass exactly one of space_id or page_group_id.', 400);
  }
  return args.space_id !== undefined ? { space_id: args.space_id } : { page_group_id: args.page_group_id! };
}

/** The "Links on this page" appendix: pages and documents first, with what to call. */
export function linksAppendix(links: ExtractedLink[]): string {
  if (!links.length) return '';
  const label = (l: ExtractedLink) => {
    const t = l.text || l.url;
    return l.context && l.context !== t ? `${t} — ${l.context}` : t;
  };
  const section = (title: string, items: string[]) => (items.length ? [`### ${title}`, '', ...items, ''] : []);
  const pages = links
    .filter((l) => l.kind === 'page')
    .map((l) => `- ${label(l)} → workvivo_get_page ${l.space_id !== undefined ? `space_id=${l.space_id}` : `page_group_id=${l.page_group_id}`} page="${l.page}"`);
  const docs = links
    .filter((l) => l.kind === 'document')
    .map((l) => `- ${label(l)} → workvivo_get_document document_id=${l.document_id}`);
  const other = links.filter((l) => l.kind !== 'page' && l.kind !== 'document').map((l) => `- [${label(l)}](${l.url})`);
  return ['## Links on this page', '', ...section('Pages', pages), ...section('Documents', docs), ...section('Other links', other)]
    .join('\n')
    .trim();
}

export function registerPageTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_list_pages',
    {
      title: 'List the pages of a Workvivo space',
      description: untrustedDescription(
        'List the pages (the wiki-style content pages) of a Workvivo space — or of a global page collection — as ' +
          'a tree: each page\'s id, title and slug, with its child pages nested. Read any of them with ' +
          'workvivo_get_page. Read-only.',
      ),
      _meta: LOOKUP,
      annotations: readAnnotations('List the pages of a Workvivo space'),
      inputSchema: z.object({ ...scopeArgs }),
    },
    async (args) => {
      const scope = scopeOf(args);
      const data = await client.getPageTree(scope);
      const tree = pageTree(data.pages);
      return untrustedResult(
        { ...scope, page_count: flattenTree(tree).length, pages: tree },
        { note: WV_UNTRUSTED_NOTE },
      );
    },
  );

  server.registerTool(
    'workvivo_get_page',
    {
      title: 'Read a Workvivo page as Markdown',
      description: untrustedDescription(
        'Read one Workvivo page (a space\'s wiki-style content page, or a global page) and return its full ' +
          'content as Markdown, with a front-matter header (title, ids, slug, last update, url). Works for both ' +
          'of Workvivo\'s page editors. Pass the page\'s slug (as in its URL, e.g. `spaces/18180/pages/76498` → ' +
          'page "76498") or its id; omit `page` for the space\'s landing page. The appendix lists every link on ' +
          'the page — linked pages (read with this tool) and linked documents (read with ' +
          'workvivo_get_document). `format: "json"` returns the same as structured data. Read-only.',
      ),
      _meta: LOOKUP,
      annotations: readAnnotations('Read a Workvivo page as Markdown'),
      inputSchema: z.object({
        ...scopeArgs,
        page: z
          .union([z.string().trim().min(1).max(300), z.number().int().positive()])
          .optional()
          .describe('The page slug or id. Omit for the landing page.'),
        format: z.enum(['markdown', 'json']).optional().describe('markdown (default) or json.'),
        include_links: z.boolean().optional().describe('Append the "Links on this page" index (default true).'),
      }),
    },
    async ({ page, format, include_links, ...rest }) => {
      const scope = scopeOf(rest);
      const data = await client.getPage(scope, page);
      const record = (data.page ?? data) as Record<string, unknown>;
      if (!record || typeof record !== 'object' || record.id === undefined) {
        throw new WorkvivoApiError('Workvivo returned no page for that slug or id.', 404, 'List the pages with workvivo_list_pages.');
      }
      const origin = client.origin;
      const meta = pageMeta(record, origin);
      const markdown = pageMarkdown(record, origin);
      const links = extractLinks(markdown, origin);
      if (format === 'json') {
        return untrustedResult(redactSensitive({ ...meta, markdown, links }), { note: WV_UNTRUSTED_NOTE });
      }
      const title = typeof meta.title === 'string' ? `# ${meta.title}\n\n` : '';
      const appendix = include_links === false ? '' : linksAppendix(links);
      return markdownResult(meta, `${title}${markdown ? rebaseHeadings(markdown, 2) : '_(This page has no content.)_'}${appendix ? `\n\n${appendix}` : ''}`);
    },
  );
}
