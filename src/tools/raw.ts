import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { WorkvivoApiError, type WorkvivoClient } from '../client.js';
import { redactSensitive } from '../project.js';
import { untrustedDescription, WV_UNTRUSTED_NOTE } from '../view.js';
import { untrustedResult } from '@chrischall/mcp-utils';
import { readAnnotations } from './common.js';

/** A relative `/api/` path: segments, then an optional query. No `..`, no scheme, no host. */
const PATH_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.,-]+)*\/?(?:\?[A-Za-z0-9_.,~%=&+:-]*)?$/;

/**
 * Workvivo has a few GETs that CHANGE state (the SPA calls them as GETs):
 * marking a space visited, exports, downloads, toggles. The escape hatch
 * refuses any path whose segments name an action rather than a resource.
 */
const ACTION_SEGMENT =
  /^(update-last-visited|mark-?\w*|read|unread|toggle\w*|subscribe|unsubscribe|enrol|unenrol|export|download|process|approve|reject|delete|destroy|logout|push|restore|archive|unarchive|pin|unpin|attach|jwt-identity|assertion|saml-details|passcode|token\w*|webpushtoken)$/i;

export function assertReadPath(raw: string): string {
  const p = raw.trim().replace(/^\/+/, '').replace(/^api\//, '');
  if (!PATH_RE.test(p) || p.split('/').some((s) => s === '..' || s === '.')) {
    throw new WorkvivoApiError(
      `Not a relative Workvivo API path: ${JSON.stringify(raw)}`,
      400,
      'Pass a path under /api/, e.g. "terms/departments" or "spaces/123/links".',
    );
  }
  const segments = p.split('?')[0]!.split('/');
  const action = segments.find((s) => ACTION_SEGMENT.test(s));
  if (action) {
    throw new WorkvivoApiError(
      `Refusing ${JSON.stringify(p)}: "${action}" is an action endpoint, and this tool only reads.`,
      400,
    );
  }
  return p;
}

export function registerRawTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_api_get',
    {
      title: 'GET a Workvivo API path',
      description: untrustedDescription(
        'Read-only escape hatch: GET any Workvivo /api/ path not covered by a dedicated tool and return its ' +
          'JSON unprojected (credential-shaped fields redacted). Examples: "terms/departments", ' +
          '"terms/locations", "terms/<id>/people?page=1", "spaces/<id>/links", "articles/read-more/<id>", ' +
          '"people/<id>/followers?page=1", "likedby/update/<id>", "search/<name>?v2=1". Action-style paths ' +
          '(update-last-visited, export, download, toggles…) are refused. Responses can be large — prefer the ' +
          'dedicated tools. Read-only.',
      ),
      annotations: readAnnotations('GET a Workvivo API path'),
      inputSchema: z.object({
        path: z.string().min(1).max(500).describe('Path relative to /api/, with an optional query string.'),
      }),
    },
    async ({ path }) => {
      const data = await client.get(assertReadPath(path));
      return untrustedResult(redactSensitive(data), { note: WV_UNTRUSTED_NOTE });
    },
  );
}
