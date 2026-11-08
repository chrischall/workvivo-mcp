// Text extraction for linked documents.
//
// Workvivo's document links (`/document/link/<id>`, `/file/<id>`) 302 to a
// signed file host (see src/download.ts for how the file is fetched). A local
// install saves it on this machine (`extractDocument(path)`); a hosted server
// holds the bytes the bridge returned in memory (`extractDocumentBytes`). This
// module turns either into Markdown-ish text:
//
//   - PDF  → per-page text via `unpdf` (pdf.js). pdf.js logs warnings with
//     console.log — STDOUT, the MCP's JSON-RPC channel — so it runs with
//     `verbosity: 0`.
//   - DOCX → HTML via `mammoth`, then the same HTML→Markdown as pages.
//   - text/markdown/csv/json/xml → as-is; HTML → Markdown.
//   - anything else (pptx, xlsx, images, video) → no text; the caller reports
//     the saved path so the user can open it.
//
// The heavy libraries are imported lazily so a server that never reads a
// document never loads them.

import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { htmlToMarkdown, tidyMarkdown } from './markdown.js';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export type DocumentFormat = 'pdf' | 'docx' | 'text' | 'html' | 'unsupported';

export interface ExtractedDocument {
  format: DocumentFormat;
  /** Markdown/plain text; absent for unsupported formats. */
  text?: string;
  /** PDF page count. */
  pages?: number;
  /** Why there is no text, when there is none. */
  note?: string;
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.log', '.yaml', '.yml']);

export function formatOf(path: string, mime?: string): DocumentFormat {
  const ext = extname(path).toLowerCase();
  const m = (mime ?? '').toLowerCase();
  if (ext === '.pdf' || m === 'application/pdf') return 'pdf';
  if (ext === '.docx' || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === '.html' || ext === '.htm' || m === 'text/html') return 'html';
  if (TEXT_EXT.has(ext) || m.startsWith('text/') || m === 'application/json') return 'text';
  return 'unsupported';
}

/** Read a regular file, refusing anything over the size cap. */
async function readBounded(path: string): Promise<Buffer> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
  if (st.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`document is ${st.size} bytes, over the ${MAX_DOCUMENT_BYTES}-byte limit`);
  }
  const fh = await open(path, 'r');
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

export async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t, i) => `<!-- page ${i + 1} -->\n\n${t.trim()}`);
  return { text: tidyMarkdown(pages.join('\n\n')), pages: totalPages };
}

export async function extractDocx(bytes: Buffer, origin: string): Promise<string> {
  const mammoth = await import('mammoth');
  const convert = (mammoth as unknown as { convertToHtml: typeof import('mammoth').convertToHtml }).convertToHtml
    ?? (mammoth as unknown as { default: { convertToHtml: typeof import('mammoth').convertToHtml } }).default.convertToHtml;
  const { value } = await convert({ buffer: bytes });
  return htmlToMarkdown(value, origin);
}

/** Extract readable text from a downloaded file. Never throws for an unknown type. */
export async function extractDocument(path: string, mime: string | undefined, origin: string): Promise<ExtractedDocument> {
  const format = formatOf(path, mime);
  if (format === 'unsupported') {
    return { format, note: `No text extraction for ${extname(path) || mime || 'this file type'}; open the saved file instead.` };
  }
  return extractFormat(format, await readBounded(path), origin, 'open the saved file');
}

/**
 * Extract readable text from bytes held in memory (a hosted read, which saves
 * nothing). `name` gives the type, as a saved file's path does.
 */
export async function extractDocumentBytes(
  data: Uint8Array,
  name: string,
  mime: string | undefined,
  origin: string,
): Promise<ExtractedDocument> {
  const format = formatOf(name, mime);
  if (format === 'unsupported') {
    return { format, note: `No text extraction for ${extname(name) || mime || 'this file type'}; use the download link instead.` };
  }
  return extractFormat(format, Buffer.from(data.buffer, data.byteOffset, data.byteLength), origin, 'use the download link');
}

async function extractFormat(
  format: Exclude<DocumentFormat, 'unsupported'>,
  bytes: Buffer,
  origin: string,
  openIt: string,
): Promise<ExtractedDocument> {
  switch (format) {
    case 'pdf': {
      const { text, pages } = await extractPdf(new Uint8Array(bytes));
      return text.replace(/<!-- page \d+ -->/g, '').trim()
        ? { format, text, pages }
        : { format, pages, note: `The PDF has no text layer (likely scanned images); ${openIt} instead.` };
    }
    case 'docx':
      return { format, text: await extractDocx(bytes, origin) };
    case 'html':
      return { format, text: htmlToMarkdown(bytes.toString('utf8'), origin) };
    default:
      return { format, text: bytes.toString('utf8') };
  }
}

/** A window of `text` starting at `offset`, at most `maxChars` long. */
export function windowOf(text: string, offset: number, maxChars: number): { text: string; total: number; next_offset?: number } {
  const total = text.length;
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(total, start + maxChars);
  return { text: text.slice(start, end), total, ...(end < total ? { next_offset: end } : {}) };
}
