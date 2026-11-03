// Workvivo page/article content → Markdown.
//
// Pages come in two editor formats (verified on a live tenant, 2026-11-03):
//
//  - `editor_type: "tinymce"`: HTML in `html_content`, laid out with
//    Bootstrap grid divs (`mceTmpl`/`row`/`col-sm-*`), `alert` boxes, inline
//    styles, images on SIGNED CloudFront URLs (`?Expires=…&Signature=…`) and
//    absolute in-app links.
//  - `editor_type: "lexical"`: `html_content` is empty and `json_content` is a
//    JSON string `{ blocks: [...] }` of typed blocks (paragraph, heading,
//    list/listitem, layout-container/-item, alert-component,
//    collapsible-container, button, image, card/cards-container,
//    horizontalrule). Every text-bearing block's `content.text` is ALREADY
//    Markdown (`**bold**`, `[label](/document/link/123)`), so the walker only
//    adds the block structure.
//
// Both converge on Markdown with absolute links, and `extractLinks` classifies
// every link so an agent can follow pages and documents without re-parsing.

import TurndownService from 'turndown';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A signed media URL is a short-lived credential and useless once expired. */
function isSignedUrl(src: string): boolean {
  return /[?&](Signature|X-Amz-Signature|Expires|Key-Pair-Id)=/i.test(src);
}

/** Make an in-app path absolute against the Workvivo origin; leave others alone. */
export function absolutize(url: string, origin: string): string {
  const u = url.trim();
  if (/^\/(?!\/)/.test(u)) return `${origin}${u}`;
  return u;
}

/** Collapse runs of blank lines and trim trailing spaces left by layout markup. */
export function tidyMarkdown(md: string): string {
  return md
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // A heading whose only content was an image / &nbsp; renders as bare #'s.
    .replace(/^#{1,6}[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    // Layout blocks emit back-to-back rules; one is enough.
    .replace(/^---\n\n(?:---\n\n)+/gm, '---\n\n')
    .replace(/\n\n---\s*$/, '')
    .trim();
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>').trim();
}

function buildTurndown(origin: string): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.remove(['script', 'style', 'noscript']);

  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const alt = (el.getAttribute('alt') ?? '').trim();
      const src = (el.getAttribute('src') ?? '').trim();
      if (!src || isSignedUrl(src)) return alt ? `[image: ${alt}]` : '';
      return `![${alt}](${absolutize(src, origin)})`;
    },
  });

  td.addRule('iframe', {
    filter: 'iframe',
    replacement: (_content, node) => {
      const src = ((node as HTMLElement).getAttribute('src') ?? '').trim();
      return src ? `\n\n[Embedded content](${absolutize(src, origin)})\n\n` : '';
    },
  });

  td.addRule('link', {
    filter: (node) => node.nodeName === 'A' && !!(node as HTMLElement).getAttribute('href'),
    replacement: (content, node) => {
      const href = absolutize((node as HTMLElement).getAttribute('href') ?? '', origin);
      const text = content.replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return `[${text}](${href})`;
    },
  });

  // GitHub-flavoured tables: first row is the header (Workvivo's editor emits
  // plain <tr><td> rows, rarely <th>).
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLElement).querySelectorAll('tr'));
      const grid = rows.map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((cell) => escapeCell(td.turndown((cell as HTMLElement).innerHTML))),
      );
      const width = Math.max(0, ...grid.map((r) => r.length));
      if (width === 0) return '';
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
      const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
      const [head, ...body] = grid;
      return `\n\n${line(head!)}\n| ${Array(width).fill('---').join(' | ')} |\n${body.map(line).join('\n')}\n\n`;
    },
  });
  return td;
}

/** TinyMCE page/article HTML → Markdown with absolute links. */
export function htmlToMarkdown(html: string, origin: string): string {
  if (!html.trim()) return '';
  return tidyMarkdown(buildTurndown(origin).turndown(html));
}

/** Rewrite `](/path)` links inside Markdown text to absolute ones. */
function absolutizeMarkdownLinks(md: string, origin: string): string {
  return md.replace(/\]\((\/[^)\s]*)\)/g, (_m, p: string) => `](${absolutize(p, origin)})`);
}

/** Lexical text is Markdown, but may still carry inline HTML (`<span style>`). */
function stripInlineHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, '');
}

const blockText = (b: Rec): string => {
  const c = isRec(b.content) ? b.content : undefined;
  return stripInlineHtml(str(c?.text) ?? str(c?.rawText) ?? '');
};

const childrenOf = (v: unknown): unknown[] => (isRec(v) && Array.isArray(v.children) ? v.children : Array.isArray(v) ? v : []);

/** Lexical `{ blocks: [...] }` → Markdown with absolute links. */
export function lexicalToMarkdown(json: string | Rec, origin: string): string {
  let doc: unknown = json;
  if (typeof json === 'string') {
    try {
      doc = JSON.parse(json);
    } catch {
      return '';
    }
  }
  const blocks = isRec(doc) && Array.isArray(doc.blocks) ? doc.blocks : isRec(doc) && isRec(doc.root) ? childrenOf(doc.root) : [];

  const render = (nodes: unknown[], depth = 0): string[] => nodes.flatMap((n) => block(n, depth));

  function block(n: unknown, depth: number): string[] {
    if (!isRec(n)) return [];
    const type = str(n.type) ?? '';
    const text = absolutizeMarkdownLinks(blockText(n), origin);
    switch (type) {
      case 'paragraph':
      case 'styled-paragraph':
        return text.trim() ? [text] : [];
      case 'heading': {
        const level = Math.min(6, Math.max(1, typeof n.level === 'number' ? n.level : 2));
        // Heading text often carries its own `**…**`; a heading is bold already.
        const t = text.replace(/^\*\*(.*)\*\*$/s, '$1').trim();
        return t ? [`${'#'.repeat(level)} ${t}`] : [];
      }
      case 'horizontalrule':
        return ['---'];
      case 'list': {
        const ordered = n.listType === 'number';
        return [
          childrenOf(n)
            .map((li, i) => {
              const body = render(childrenOf(li), depth + 1).join(' ').trim();
              return `${'  '.repeat(depth)}${ordered ? `${i + 1}.` : '-'} ${body}`;
            })
            .join('\n'),
        ];
      }
      case 'listitem':
        return render(childrenOf(n), depth);
      case 'alert-component': {
        const inner = render(childrenOf(n), depth).join('\n\n');
        return inner ? [inner.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')] : [];
      }
      case 'collapsible-container': {
        const title = isRec(n.title) ? absolutizeMarkdownLinks(blockText(n.title), origin).replace(/^\*\*(.*)\*\*$/s, '$1').trim() : '';
        const body = render(childrenOf(n.text), depth);
        return [...(title ? [`**${title}**`] : []), ...body];
      }
      case 'button': {
        const label = isRec(n.text) ? blockText(n.text).trim() : '';
        const url = str(n.url)?.trim();
        if (!url) return label ? [label] : [];
        return [`[${label || url}](${absolutize(url, origin)})`];
      }
      case 'image': {
        const src = str(n.src)?.trim();
        const alt = isRec(n.altText) ? blockText(n.altText).trim() : '';
        if (!src || isSignedUrl(src)) return alt ? [`[image: ${alt}]`] : [];
        return [`![${alt}](${absolutize(src, origin)})`];
      }
      case 'cards-container':
        return render(Array.isArray(n.cards) ? n.cards : [], depth);
      case 'card': {
        const title = render(childrenOf(n.title), depth).join(' ').trim();
        const desc = render(childrenOf(n.description), depth);
        const link = isRec(n.link) ? str(n.link.url) : str(n.link);
        const head = title ? (link ? `**[${title}](${absolutize(link, origin)})**` : `**${title}**`) : '';
        return [...(head ? [head] : []), ...desc];
      }
      default: {
        // layout-container / layout-item and any block type not seen yet:
        // keep its text and its children rather than dropping content.
        const kids = render(childrenOf(n), depth);
        return text.trim() ? [text, ...kids] : kids;
      }
    }
  }

  return tidyMarkdown(render(blocks).join('\n\n'));
}

export type LinkKind = 'page' | 'document' | 'file' | 'workvivo' | 'external';

export interface ExtractedLink {
  kind: LinkKind;
  text: string;
  url: string;
  /** For pages: where to read it with workvivo_get_page. */
  space_id?: number;
  page_group_id?: number;
  page?: string;
  /** For documents: the id workvivo_get_document takes. */
  document_id?: number;
  /** The nearest heading or bold title above the link — what a "View" / "ES"
   *  link actually points at. */
  context?: string;
}

/** A line that titles what follows: a heading, or a line that is all bold. */
function titleOf(line: string): string | undefined {
  const t = line.trim().replace(/^>\s*/, '');
  const h = /^#{1,6}\s+(.+)$/.exec(t);
  if (h) return h[1]!.replace(/\*\*/g, '').trim();
  const b = /^\*\*([^*]+)\*\*$/.exec(t);
  return b ? b[1]!.trim() : undefined;
}

/** Every Markdown link, de-duplicated by URL and classified for navigation. */
export function extractLinks(markdown: string, origin: string): ExtractedLink[] {
  const host = new URL(origin).host;
  const seen = new Map<string, ExtractedLink>();
  let context: string | undefined;
  let lastTitled: string | undefined;
  for (const line of markdown.split('\n')) {
   const title = titleOf(line);
   if (title !== undefined && !/\]\(/.test(line)) context = title;
   for (const m of line.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    if (m[1] === '!') continue; // images are not navigation
    const text = m[2]!.replace(/\*\*/g, '').trim();
    const url = m[3]!;
    if (seen.has(url)) {
      if (!seen.get(url)!.text && text) seen.get(url)!.text = text;
      continue;
    }
    let link: ExtractedLink = { kind: 'external', text, url };
    let u: URL | undefined;
    try {
      u = new URL(url);
    } catch {
      u = undefined;
    }
    if (u && u.host === host) {
      const p = u.pathname;
      let mm: RegExpExecArray | null;
      if ((mm = /^\/spaces\/(\d+)\/pages\/([^/?#]+)\/?$/.exec(p))) {
        link = { kind: 'page', text, url, space_id: Number(mm[1]), page: decodeURIComponent(mm[2]!) };
      } else if ((mm = /^\/pages\/(\d+)\/([^/?#]+)\/?$/.exec(p))) {
        link = { kind: 'page', text, url, page_group_id: Number(mm[1]), page: decodeURIComponent(mm[2]!) };
      } else if ((mm = /^\/document\/link\/(\d+)\/?$/.exec(p))) {
        link = { kind: 'document', text, url, document_id: Number(mm[1]) };
      } else if (/^\/file\/\d+\/?$/.test(p)) {
        link = { kind: 'file', text, url };
      } else {
        link = { kind: 'workvivo', text, url };
      }
    }
    // A bare language code ("ES" | "PT" | "FR") is a translation of the link
    // right before it — say which document it translates.
    const langCode = /^[A-Z]{2}(?:-[A-Z]{2})?$/.test(text);
    if (langCode && lastTitled) link.context = `${lastTitled} (${text})`;
    else if (context && context !== text) link.context = context;
    if (!langCode && text.length > 3 && !/^(view|open|download|read more|learn more|click here|here)\b/i.test(text)) {
      lastTitled = text.replace(/\s*→\s*$/, '');
    }
    seen.set(url, link);
   }
  }
  return [...seen.values()];
}

/**
 * Re-base a page body's headings so its SMALLEST level becomes `top` (capped
 * at h6), keeping their relative structure. Workvivo bodies often start at h4,
 * so a fixed shift would flatten everything to h6 under a page title.
 */
export function rebaseHeadings(md: string, top: number): string {
  const levels = [...md.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1]!.length);
  if (!levels.length) return md;
  const shift = top - Math.min(...levels);
  return md.replace(/^(#{1,6})(\s)/gm, (_m, h: string, sp: string) => `${'#'.repeat(Math.max(1, Math.min(6, h.length + shift)))}${sp}`);
}
