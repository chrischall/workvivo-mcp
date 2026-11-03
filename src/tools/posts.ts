import type { McpServer } from '@modelcontextprotocol/server';
import { mapWithConcurrency } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { comment, person, post } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { listOf } from './news.js';
import { idArg, pageArg, readAnnotations } from './common.js';

/** Comment-bearing item types — each verified live against `comments/<type>/<id>`. */
export const COMMENTABLE = ['update', 'article', 'event', 'kudos'] as const;

/** At most this many distinct commenters are resolved to names per call. */
const MAX_NAME_LOOKUPS = 15;

export function registerPostTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_get_post',
    {
      title: 'Read a Workvivo post or shoutout',
      description: untrustedDescription(
        'Read one Workvivo post (an "update") or shoutout ("kudos") in full: author, time, text, who it ' +
          'thanks or mentions, and like/comment counts. Take `type` and `id` from a feed entry or search ' +
          'result (`comments/update/<id>`, `comments/kudos/<id>`). Its comments: workvivo_get_comments. Read-only.',
      ),
      annotations: readAnnotations('Read a Workvivo post or shoutout'),
      inputSchema: z.object({
        type: z.enum(['update', 'kudos']).describe('"update" for a post, "kudos" for a shoutout.'),
        id: idArg('post'),
        view: viewArg('author, time, full text, recipients/mentions and counts'),
      }),
    },
    async ({ type, id, view }) => {
      const data = await client.get(`${type === 'kudos' ? 'kudos' : 'updates'}/${id}`);
      return respond(view, data, (d) => post(d, type), type);
    },
  );

  server.registerTool(
    'workvivo_list_shoutouts',
    {
      title: 'List Workvivo shoutouts',
      description: untrustedDescription(
        'List recent shoutouts (kudos — public thank-yous and recognition) across Workvivo, newest first: who ' +
          'gave it, who it thanks, and the message. Read-only.',
      ),
      annotations: readAnnotations('List Workvivo shoutouts'),
      inputSchema: z.object({
        page: pageArg,
        view: viewArg('giver, recipients, time, message and counts per shoutout'),
      }),
    },
    async ({ page, view }) => {
      const data = await client.get('kudos', { page: page ?? 1 });
      return respond(view, data, listOf((k) => post(k, 'kudos')), 'shoutouts');
    },
  );

  server.registerTool(
    'workvivo_get_comments',
    {
      title: 'Read comments on a Workvivo item',
      description: untrustedDescription(
        'Read the comments on a Workvivo post, article, event or shoutout, oldest first, with each ' +
          "commenter's name, time, text and likes (`reply_to` links a reply to its parent comment). Take " +
          '`type` and `id` from a feed entry, list or search result. Read-only.',
      ),
      annotations: readAnnotations('Read comments on a Workvivo item'),
      inputSchema: z.object({
        type: z.enum(COMMENTABLE).describe('The item type: update (a post), article, event or kudos (a shoutout).'),
        id: idArg('item'),
        view: viewArg('commenter name, time, text, likes and reply links (names resolved for up to 15 commenters)'),
      }),
    },
    async ({ type, id, view }) => {
      const data = await client.get(`comments/${type}/${id}`);
      const names = new Map<number, string>();
      if (view !== 'full' && Array.isArray(data)) {
        // Comments carry only a user_id; resolve names for the compact rung.
        const ids = [...new Set(data.map((c) => (c as { user_id?: unknown }).user_id).filter((u): u is number => typeof u === 'number'))];
        await mapWithConcurrency(ids.slice(0, MAX_NAME_LOOKUPS), 4, async (uid) => {
          try {
            const p = person(await client.get(`people/${uid}`));
            if (typeof p.name === 'string') names.set(uid, p.name);
          } catch {
            // A missing or alumni profile leaves `by` unset; the user_id stays.
          }
        });
      }
      return respond(
        view,
        data,
        (d) => (Array.isArray(d) ? { comments: d.map((c) => comment(c, names)) } : undefined),
        'comments',
      );
    },
  );
}
