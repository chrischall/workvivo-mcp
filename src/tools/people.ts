import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { listOf, me, person, personDetail } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { idArg, pageArg, readAnnotations } from './common.js';
import { LOOKUP, workMeta } from './hints.js';

export function registerPeopleTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_search_people',
    {
      title: 'Search the Workvivo people directory',
      description: untrustedDescription(
        'Search the company people directory on Workvivo by name (or browse it without a query): name, job ' +
          'title, department, location and work email for each person, plus the directory total. Open a ' +
          'profile with workvivo_get_person. Read-only.',
      ),
      _meta: workMeta('lookup', { aliases: ['colleague', 'coworker', 'who is', 'directory'] }),
      annotations: readAnnotations('Search the Workvivo people directory'),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).optional().describe('Name (or part of one) to search for.'),
        page: pageArg,
        view: viewArg('id, name, job title, department, location and email per person'),
      }),
    },
    async ({ query, page, view }) => {
      const data = await client.get('people', { page: page ?? 1, query, includeExternal: 'true' });
      return respond(
        view,
        data,
        (d) => {
          const out = listOf(person)(d) as { items: unknown[]; next_page?: number } | undefined;
          if (!out) return undefined;
          const total = (d as { all?: unknown }).all;
          return { ...(typeof total === 'number' ? { directory_total: total } : {}), people: out.items, ...(out.next_page ? { next_page: out.next_page } : {}) };
        },
        'people',
      );
    },
  );

  server.registerTool(
    'workvivo_get_person',
    {
      title: 'Read a Workvivo profile',
      description: untrustedDescription(
        "Read a colleague's Workvivo profile: job title, department, location, email, hire date, manager, " +
          'number of direct reports, bio, expertise and interests. Take the id from workvivo_search_people, a ' +
          'feed entry (`by_id`) or a comment (`user_id`). Read-only.',
      ),
      _meta: LOOKUP,
      annotations: readAnnotations('Read a Workvivo profile'),
      inputSchema: z.object({
        person_id: idArg('person'),
        view: viewArg('role, org placement, manager, bio, expertise and interests (no phone numbers or birthday)'),
      }),
    },
    async ({ person_id, view }) => {
      const data = await client.get(`people/${person_id}`);
      return respond(view, data, personDetail, 'person');
    },
  );

  server.registerTool(
    'workvivo_get_me',
    {
      title: 'Read your own Workvivo account',
      description:
        'Read who you are signed in to Workvivo as: name, email, job title, department, location, cost ' +
        'centre, hire date, timezone and roles. Read-only.',
      _meta: LOOKUP,
      annotations: readAnnotations('Read your own Workvivo account'),
      inputSchema: z.object({
        view: viewArg('your identity, role and org placement (the raw record is ~80 KB of org settings)'),
      }),
    },
    async ({ view }) => {
      const data = await client.get('user');
      return respond(view, data, me, 'user');
    },
  );

  server.registerTool(
    'workvivo_get_my_team',
    {
      title: 'List your Workvivo team',
      description:
        'List the people on your team in Workvivo (as the directory defines it — your manager and peers or ' +
        'your reports): name, job title, department, location and email. Read-only.',
      _meta: workMeta('lookup', { aliases: ['my team', 'my manager', 'reports'] }),
      annotations: readAnnotations('List your Workvivo team'),
      inputSchema: z.object({
        view: viewArg('id, name, job title, department, location and email per person'),
      }),
    },
    async ({ view }) => {
      const data = await client.get('people/my/team');
      return respond(view, data, (d) => (Array.isArray(d) ? { people: d.map(person) } : undefined), 'team');
    },
  );
}

