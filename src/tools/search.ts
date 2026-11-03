import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { searchHit } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { pageArg, readAnnotations } from './common.js';

/** Federated-search content types the server accepts (an unknown one is a 422). */
export const SEARCH_TYPES = [
  'article',
  'update',
  'event',
  'user',
  'space',
  'docs',
  'page',
  'kudos',
  'question_post',
  'question_post_answer',
  'term',
  'goal',
  'comment',
  'livestream',
  'podcast',
  'file',
  'welcome',
  'anniversary',
  'birthday',
  'apps',
] as const;

const DEFAULT_TYPES = ['article', 'update', 'event', 'user', 'space', 'docs', 'page', 'kudos', 'question_post'] as const;

export function registerSearchTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_search',
    {
      title: 'Search Workvivo',
      description: untrustedDescription(
        'Full-text search across Workvivo — news articles, posts, events, people, spaces, documents, pages, ' +
          'shoutouts and questions — ranked by relevance, with each hit\'s type, id, title, author and a snippet. ' +
          'Narrow with `types` (e.g. ["article","event"]). Open a hit by its type and id with the matching get ' +
          'tool. Read-only, but Workvivo records the query in your own search history.',
      ),
      annotations: readAnnotations('Search Workvivo'),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe('What to search for.'),
        types: z
          .array(z.enum(SEARCH_TYPES))
          .min(1)
          .optional()
          .describe(`Content types to search (default: ${DEFAULT_TYPES.join(', ')}). "user" = people, "term" = teams/departments, "docs" = documents.`),
        page: pageArg,
        view: viewArg('type, id, title, url, author, update time and a snippet per hit, plus page/last_page'),
      }),
    },
    async ({ query, types, page, view }) => {
      const data = await client.postJson('federated-search', {
        page: page ?? 1,
        query,
        types: types ?? [...DEFAULT_TYPES],
      });
      return respond(
        view,
        data,
        (d) => {
          const r = (d ?? {}) as { data?: unknown; current_page?: unknown; last_page?: unknown };
          if (!Array.isArray(r.data)) return undefined;
          return { page: r.current_page, last_page: r.last_page, results: r.data.map(searchHit) };
        },
        'search',
      );
    },
  );
}
