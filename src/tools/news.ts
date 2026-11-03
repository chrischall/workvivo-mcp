import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { articleDetail, articleSummary, nextPage } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { idArg, pageArg, readAnnotations } from './common.js';

type Rec = Record<string, unknown>;

/** A Laravel page of records → `{ items, next_page }`; a bare array → `{ items }`. */
export function listOf(project: (r: unknown) => unknown) {
  return (data: unknown): unknown => {
    if (Array.isArray(data)) return { items: data.map(project) };
    const page = (data ?? {}) as Rec;
    const items = Array.isArray(page.data) ? page.data.map(project) : undefined;
    if (!items) return undefined; // not a page — projectOrRaw falls back to the raw value
    const next = nextPage(page);
    return next !== undefined ? { items, next_page: next } : { items };
  };
}

export function registerNewsTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_list_news',
    {
      title: 'List Workvivo news articles',
      description: untrustedDescription(
        'List company news articles on Workvivo (the intranet newsroom), newest first: title, subtitle, ' +
          'publish time, author, spaces and comment counts. Pass `space_id` for one space\'s news, or ' +
          '`featured: true` for the currently featured stories. Read one in full with workvivo_get_article. Read-only.',
      ),
      annotations: readAnnotations('List Workvivo news articles'),
      inputSchema: z.object({
        space_id: idArg('space').optional().describe('Only this space\'s published news.'),
        featured: z.boolean().optional().describe('Only the featured stories (ignores page and space_id).'),
        page: pageArg,
        view: viewArg('id, title, subtitle, published time, author, counts, spaces and url per article'),
      }),
    },
    async ({ space_id, featured, page, view }) => {
      const data =
        featured === true
          ? await client.get('articles/featured')
          : space_id !== undefined
            ? await client.get(`spaces/${space_id}/news`, { page: page ?? 1, type: 'published' })
            : await client.get('articles', { page: page ?? 1 });
      return respond(view, data, listOf(articleSummary), 'news');
    },
  );

  server.registerTool(
    'workvivo_get_article',
    {
      title: 'Read a Workvivo news article',
      description: untrustedDescription(
        'Read one Workvivo news article in full — title, subtitle, author, publish time, spaces and the body ' +
          'as plain text. Take the id from workvivo_list_news, the feed, or search (`news/<id>`). Its comments: ' +
          'workvivo_get_comments with type "article". Read-only.',
      ),
      annotations: readAnnotations('Read a Workvivo news article'),
      inputSchema: z.object({
        article_id: idArg('article'),
        view: viewArg('the article\'s metadata and its body as plain text'),
      }),
    },
    async ({ article_id, view }) => {
      const data = await client.get(`articles/${article_id}`);
      return respond(view, data, articleDetail, 'article');
    },
  );
}
