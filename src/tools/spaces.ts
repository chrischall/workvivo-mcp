import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { WorkvivoApiError, type WorkvivoClient } from '../client.js';
import { listOf, space } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { idArg, pageArg, readAnnotations } from './common.js';
import { LOOKUP } from './hints.js';

export function registerSpaceTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_list_spaces',
    {
      title: 'List Workvivo spaces',
      description: untrustedDescription(
        'List Workvivo spaces (communities, teams, offices, employee groups): `scope` "mine" for the spaces ' +
          'you belong to, "all" for every visible space, "trending" for the most active right now, or pass ' +
          '`query` to search spaces by name. Each has its member count and whether you are a member. Then read ' +
          'a space with workvivo_get_space, its feed with workvivo_get_feed, its news with workvivo_list_news ' +
          'or its events with workvivo_list_events. Read-only.',
      ),
      _meta: LOOKUP,
      annotations: readAnnotations('List Workvivo spaces'),
      inputSchema: z.object({
        scope: z.enum(['mine', 'all', 'trending']).optional().describe('Which spaces (default "mine"; ignored when `query` is set).'),
        query: z.string().trim().min(1).max(200).optional().describe('Search spaces by name.'),
        page: pageArg,
        view: viewArg('id, name, short description, member count, membership and url per space'),
      }),
    },
    async ({ scope, query, page, view }) => {
      let data: unknown;
      if (query !== undefined) {
        // `type=all` ignores `query`; the SPA sends it only with type=search (verified live).
        data = await client.get('spaces', { page: page ?? 1, type: 'search', query });
      } else if (scope === 'trending') {
        if (page !== undefined && page > 1) throw new WorkvivoApiError('The trending list has a single page.', 400);
        data = await client.get('spaces/trending');
      } else if (scope === 'all') {
        data = await client.get('spaces', { page: page ?? 1 });
      } else {
        data = await client.get('spaces', { page: page ?? 1, type: 'my', pageSize: 50 });
      }
      return respond(view, data, listOf((s) => space(s)), 'spaces');
    },
  );

  server.registerTool(
    'workvivo_get_space',
    {
      title: 'Read a Workvivo space',
      description: untrustedDescription(
        "Read one Workvivo space's details: name, full description, member count, whether you are a member, " +
          'privacy and last activity. Read-only.',
      ),
      _meta: LOOKUP,
      annotations: readAnnotations('Read a Workvivo space'),
      inputSchema: z.object({
        space_id: idArg('space'),
        view: viewArg('the space\'s name, description, membership and activity'),
      }),
    },
    async ({ space_id, view }) => {
      const data = await client.get(`spaces/${space_id}`, { info: 1 });
      return respond(view, data, (d) => space(d, { detail: true }), 'space');
    },
  );
}
