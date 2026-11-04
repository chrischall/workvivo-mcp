import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { listOf, notification } from '../project.js';
import { briefLine, briefResult } from '../brief.js';
import { briefViewArg, respond, untrustedDescription } from '../view.js';
import { workMeta } from './hints.js';
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
      _meta: workMeta('whats-new', {
        canonical: true,
        aliases: ['notifications', 'mentions', 'intranet', 'workvivo', 'anything new at work'],
      }),
      inputSchema: z.object({
        page: pageArg,
        view: briefViewArg(
          'read state, time, kind, title and target item per notification, plus unread counts',
          '"<title> — <UTC time> — <unread|read>"',
        ),
      }),
    },
    async ({ page, view }) => {
      const p = page ?? 1;
      if (view === 'brief') {
        const list = await client.get('notifications', { page: p });
        return briefResult(list, (n) => {
          const x = notification(n);
          const title = typeof x.title === 'string' ? x.title : typeof x.kind === 'string' ? x.kind : undefined;
          return briefLine(title, typeof x.at === 'string' ? x.at : undefined, x.read ? 'read' : 'unread');
        });
      }
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
