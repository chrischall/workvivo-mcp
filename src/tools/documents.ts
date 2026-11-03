import type { McpServer } from '@modelcontextprotocol/server';
import { toolAnnotations } from '@chrischall/mcp-utils';
import { basename } from 'node:path';
import { z } from 'zod';
import { WorkvivoApiError, type DocumentRef, type WorkvivoClient } from '../client.js';
import { extractDocument, windowOf } from '../documents.js';
import { markdownResult, untrustedDescription } from '../view.js';

/** Accept a document id, or a `/document/link/<id>` / `/file/<id>` URL or path. */
export function documentRefOf(args: { document_id?: number; url?: string }, host: string): DocumentRef {
  if (args.document_id !== undefined && args.url === undefined) return { kind: 'document', id: args.document_id };
  if (args.url !== undefined && args.document_id === undefined) {
    let u: URL;
    try {
      u = new URL(args.url, `https://${host}`);
    } catch {
      throw new WorkvivoApiError(`Not a URL: ${JSON.stringify(args.url)}`, 400);
    }
    if (u.host !== host) {
      throw new WorkvivoApiError(`Only Workvivo document links on ${host} can be read; got ${u.host}.`, 400);
    }
    const m = /^\/(document\/link|file)\/(\d+)\/?$/.exec(u.pathname);
    if (!m) throw new WorkvivoApiError('Expected a /document/link/<id> or /file/<id> link.', 400);
    return { kind: m[1] === 'file' ? 'file' : 'document', id: Number(m[2]) };
  }
  throw new WorkvivoApiError('Pass exactly one of document_id or url.', 400);
}

export const DEFAULT_MAX_CHARS = 20_000;

export function registerDocumentTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_get_document',
    {
      title: 'Read a Workvivo document',
      description: untrustedDescription(
        'Read a document linked from Workvivo — a `/document/link/<id>` (Workvivo\'s document library; the ' +
          '`document_id` that workvivo_get_page and workvivo_digest_space list) or a `/file/<id>` attachment — ' +
          'and return its text as Markdown: PDFs page by page, Word (.docx) with headings/lists/tables, plain text ' +
          'and HTML. Other types (PowerPoint, Excel, images) return the saved file path instead. The browser ' +
          'downloads the file through your signed-in session into its download folder on this machine (repeat ' +
          'reads reuse it). Long documents page with `offset`/`max_chars`. Does not change anything in Workvivo.',
      ),
      annotations: toolAnnotations({
        title: 'Read a Workvivo document',
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        document_id: z.coerce.number().int().positive().optional().describe('The id in a `/document/link/<id>` link.'),
        url: z.string().trim().min(1).max(2000).optional().describe('Or the link itself (`/document/link/<id>` or `/file/<id>`).'),
        offset: z.coerce.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
        max_chars: z.coerce
          .number()
          .int()
          .min(500)
          .max(200_000)
          .optional()
          .describe(`Most characters to return (default ${DEFAULT_MAX_CHARS}).`),
      }),
    },
    async ({ document_id, url, offset, max_chars }) => {
      const ref = documentRefOf({ document_id, url }, client.host);
      const file = await client.downloadDocument(ref);
      const doc = await extractDocument(file.path, file.mime, client.origin);
      const meta: Record<string, unknown> = {
        document_id: ref.kind === 'document' ? ref.id : undefined,
        file_id: ref.kind === 'file' ? ref.id : undefined,
        name: basename(file.path),
        mime: file.mime,
        bytes: file.bytes,
        format: doc.format,
        pages: doc.pages,
        saved_to: file.path,
      };
      if (!doc.text) return markdownResult(meta, `_${doc.note ?? 'No text could be extracted.'}_`);
      const w = windowOf(doc.text, offset ?? 0, max_chars ?? DEFAULT_MAX_CHARS);
      meta.total_chars = w.total;
      if (w.next_offset !== undefined) meta.next_offset = w.next_offset;
      const more = w.next_offset !== undefined ? `\n\n_(Truncated — call again with offset=${w.next_offset} for more.)_` : '';
      return markdownResult(meta, `${w.text}${more}`);
    },
  );
}
