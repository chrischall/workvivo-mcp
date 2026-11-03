import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { WorkvivoApiError, type WorkvivoClient } from '../client.js';
import { feedPage } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { idArg, pageArg, readAnnotations } from './common.js';

export function registerFeedTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_get_feed',
    {
      title: 'Read the Workvivo feed',
      description: untrustedDescription(
        'Read the Workvivo activity feed — the company intranet home feed of posts (updates), news articles, ' +
          'events, shoutouts (kudos) and questions, newest first. Pass `space_id` for one space\'s feed, or ' +
          '`person_id` for one person\'s posts. The home and space feeds page by `cursor` (return value ' +
          '`next_cursor`); a person\'s feed pages by `page`. Each entry carries its `type` and `id`: open it with ' +
          'workvivo_get_post (update/kudos), workvivo_get_article (article) or workvivo_get_event (event), and ' +
          'read its comments with workvivo_get_comments. Read-only.',
      ),
      annotations: readAnnotations('Read the Workvivo feed'),
      inputSchema: z.object({
        space_id: idArg('space').optional().describe('Read this space\'s feed instead of your home feed.'),
        person_id: idArg('person').optional().describe('Read this person\'s posts instead of your home feed.'),
        cursor: z.string().min(1).max(2000).optional().describe('`next_cursor` from the previous page (home/space feeds).'),
        page: pageArg.describe('Page number for a person\'s feed (default 1).'),
        view: viewArg('type, id, time, author, title, text (clipped to 600 chars), counts, spaces and url per entry'),
      }),
    },
    async ({ space_id, person_id, cursor, page, view }) => {
      if (space_id !== undefined && person_id !== undefined) {
        throw new WorkvivoApiError('Pass space_id or person_id, not both.', 400);
      }
      const data =
        person_id !== undefined
          ? await client.get(`people/${person_id}/feed`, { page: page ?? 1, removenoise: 'true' })
          : space_id !== undefined
            ? await client.get(`spaces/${space_id}/feed`, { next_cursor: cursor })
            : await client.get('activity', { next_cursor: cursor });
      return respond(view, data, feedPage, 'feed');
    },
  );
}
