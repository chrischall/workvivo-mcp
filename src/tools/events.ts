import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { event, listOf } from '../project.js';
import { briefLine, briefResult } from '../brief.js';
import { briefViewArg, respond, untrustedDescription, viewArg } from '../view.js';
import { LOOKUP, workMeta } from './hints.js';
import { idArg, pageArg, readAnnotations } from './common.js';

export function registerEventTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_list_events',
    {
      title: 'List upcoming Workvivo events',
      description: untrustedDescription(
        'List upcoming company events on Workvivo — town halls, office hours, webinars, social events — with ' +
          'start/end times in UTC, location or meeting link, whether you are going, and the hosting spaces. Pass ' +
          '`space_id` for one space\'s events. Full details: workvivo_get_event. Read-only.',
      ),
      annotations: readAnnotations('List upcoming Workvivo events'),
      _meta: workMeta('whats-on', {
        canonical: true,
        aliases: ['company events', 'work events', 'town hall', 'all hands', 'webinar', 'office hours'],
      }),
      inputSchema: z.object({
        space_id: idArg('space').optional().describe('Only this space\'s events.'),
        page: pageArg,
        view: briefViewArg(
          'id, title, UTC start/end, location, RSVP state, spaces and a short description per event',
          '"<title> — <UTC start> — <going|not going|no rsvp>"',
        ),
      }),
    },
    async ({ space_id, page, view }) => {
      const data =
        space_id !== undefined
          ? await client.get(`spaces/${space_id}/events`, { page: page ?? 1 })
          : await client.get('events/listings', { page: page ?? 1 });
      if (view === 'brief') {
        return briefResult(data, (e) => {
          const x = event(e);
          const status = x.is_going === true ? 'going' : x.is_going === false ? 'not going' : 'no rsvp';
          return briefLine(typeof x.title === 'string' ? x.title : 'Event', typeof x.starts === 'string' ? x.starts : undefined, status);
        });
      }
      return respond(view, data, listOf((e) => event(e)), 'events');
    },
  );

  server.registerTool(
    'workvivo_get_event',
    {
      title: 'Read a Workvivo event',
      description: untrustedDescription(
        'Read one Workvivo event in full: title, UTC start/end, all-day flag, location or meeting link, host, ' +
          'how many are going, and the description. Meeting passcodes are always redacted. Read-only.',
      ),
      annotations: readAnnotations('Read a Workvivo event'),
      _meta: LOOKUP,
      inputSchema: z.object({
        event_id: idArg('event'),
        view: viewArg('the event\'s details and full description'),
      }),
    },
    async ({ event_id, view }) => {
      // `events/<id>` answers 500; the SPA reads `events/show/<id>` (verified live).
      const data = await client.get(`events/show/${event_id}`);
      return respond(view, data, (d) => event(d, { detail: true }), 'event');
    },
  );
}
