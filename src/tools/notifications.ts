import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { listOf, notification } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { pageArg, readAnnotations } from './common.js';

export function registerNotificationTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_list_notifications',
    {
      title: 'List your Workvivo notifications',
      description: untrustedDescription(
        'List your Workvivo notifications, newest first — new articles, livestreams, mentions, comments on ' +
          'your posts — each with whether it is read and the item it points at (`item_type`/`item_id`). Page 1 ' +
          'also carries your unread counts. Listing does not mark anything read (verified). Read-only.',
      ),
      annotations: readAnnotations('List your Workvivo notifications'),
      inputSchema: z.object({
        page: pageArg,
        view: viewArg('read state, time, kind, title and target item per notification, plus unread counts'),
      }),
    },
    async ({ page, view }) => {
      const p = page ?? 1;
      const [list, unread] = await Promise.all([
        client.get('notifications', { page: p }),
        p === 1 ? client.get('notifications/unread') : Promise.resolve(undefined),
      ]);
      return respond(
        view,
        unread === undefined ? list : { unread, notifications: list },
        (d) => {
          const wrapped = unread !== undefined;
          const page_ = wrapped ? (d as { notifications: unknown }).notifications : d;
          const out = listOf(notification)(page_);
          if (!out) return undefined;
          return wrapped ? { unread, ...(out as object) } : out;
        },
        'notifications',
      );
    },
  );
}
