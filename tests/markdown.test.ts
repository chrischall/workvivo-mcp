import { describe, expect, it } from 'vitest';
import {
  absolutize,
  extractLinks,
  htmlToMarkdown,
  lexicalToMarkdown,
  rebaseHeadings,
  tidyMarkdown,
} from '../src/markdown.js';

const O = 'https://acme.workvivo.us';

describe('htmlToMarkdown (TinyMCE pages)', () => {
  it('flattens layout grids and keeps headings, lists, emphasis and absolute links', () => {
    const html = `
      <div class="mceTmpl"><div class="row"><div class="col-sm-8">
        <h4>What to <strong>Expect</strong></h4>
        <p>Read the <a href="/document/link/101">Guide</a> and the <a href="https://acme.workvivo.us/spaces/5/pages/faq">FAQ</a>.</p>
        <ul><li>One</li><li><em>Two</em></li></ul>
      </div></div></div>`;
    const md = htmlToMarkdown(html, O);
    expect(md).toContain('#### What to **Expect**');
    expect(md).toContain('[Guide](https://acme.workvivo.us/document/link/101)');
    expect(md).toContain('[FAQ](https://acme.workvivo.us/spaces/5/pages/faq)');
    expect(md).toMatch(/^-\s+One$/m);
    expect(md).toMatch(/^-\s+_Two_$/m);
    expect(md).not.toMatch(/<\/?div/);
  });

  it('never emits a signed media URL, and keeps the alt text', () => {
    const md = htmlToMarkdown(
      '<p><img alt="Team photo" src="https://cdn.example.com/a.png?Expires=1&Signature=SECRET&Key-Pair-Id=K"></p>' +
        '<p><img src="https://cdn.example.com/b.png?Signature=X"></p><p><img alt="Logo" src="/img/logo.png"></p>',
      O,
    );
    expect(md).not.toContain('SECRET');
    expect(md).not.toContain('Signature=');
    expect(md).toContain('[image: Team photo]');
    expect(md).toContain('![Logo](https://acme.workvivo.us/img/logo.png)');
  });

  it('renders tables as GFM, iframes as links, and drops empty links/headings', () => {
    const md = htmlToMarkdown(
      '<table><tr><td>Region</td><td>Contact</td></tr><tr><td>US | CA</td><td><a href="/document/link/7">Form</a></td></tr></table>' +
        '<iframe src="https://forms.example.com/x"></iframe><h4>&nbsp;</h4><a href="/x"></a><p>end</p>',
      O,
    );
    expect(md).toContain('| Region | Contact |\n| --- | --- |\n| US \\| CA | [Form](https://acme.workvivo.us/document/link/7) |');
    expect(md).toContain('[Embedded content](https://forms.example.com/x)');
    expect(md).not.toMatch(/^#+\s*$/m);
    expect(md.trim().endsWith('end')).toBe(true);
  });

  it('drops hidden content, inline data images and unsafe links; does not escape plain text', () => {
    const md = htmlToMarkdown(
      '<div style="display:none">preheader</div><h3>Benefits [draft] 5 * 3</h3>' +
        '<p><img alt="Chart" src="data:image/png;base64,AAAA"><img src="data:image/png;base64,BBBB"></p>' +
        '<p><a href="javascript:alert(1)">click</a> <a href="mailto:hr@example.com">HR</a></p>',
      O,
    );
    expect(md).not.toContain('preheader');
    expect(md).toContain('### Benefits [draft] 5 * 3');
    expect(md).not.toContain('base64');
    expect(md).toContain('[image: Chart]');
    expect(md).not.toContain('javascript:');
    expect(md).toContain('click [HR](mailto:hr@example.com)');
  });

  it('reads a linked image as a link to its target, so the target is extractable', () => {
    const md = htmlToMarkdown('<p><a href="/document/link/55"><img alt="Brochure" src="/imageRedirect/9"></a></p>', O);
    expect(md).toBe('[Brochure](https://acme.workvivo.us/document/link/55)');
    expect(extractLinks(md, O)).toMatchObject([{ kind: 'document', document_id: 55, text: 'Brochure' }]);
  });

  it('names a linked image without alt text, and drops an iframe with no source', () => {
    expect(htmlToMarkdown('<a href="/file/3"><img src="/i.png"></a><iframe></iframe>', O)).toBe('[image](https://acme.workvivo.us/file/3)');
  });

  it('encodes parentheses and spaces in URLs, so the link survives extractLinks', () => {
    const md = htmlToMarkdown('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a> <img alt="x" src="/a (1).png"></p>', O);
    expect(md).toBe('[Foo](https://en.wikipedia.org/wiki/Foo_%28bar%29) ![x](https://acme.workvivo.us/a%20%281%29.png)');
    expect(extractLinks(md, O)[0]!.url).toBe('https://en.wikipedia.org/wiki/Foo_%28bar%29');
  });

  it('collapses back-to-back rules and keeps nested lists compact', () => {
    const md = htmlToMarkdown('<ol><li><p>Pick</p><ul><li>PPO</li></ul></li><li>Go</li></ol><hr><hr><p>end</p>', O);
    expect(md).toBe('1. Pick\n   - PPO\n2. Go\n\n---\n\nend');
    expect(htmlToMarkdown('<p>a</p><hr><hr><p>&nbsp;</p>', O)).toBe('a');
  });

  it('returns empty for empty input', () => {
    expect(htmlToMarkdown('   ', O)).toBe('');
  });
});

describe('lexicalToMarkdown (Lexical pages)', () => {
  const doc = {
    blocks: [
      { type: 'heading', level: 2, content: { text: '**Resources**' } },
      {
        type: 'layout-container',
        children: [
          {
            type: 'layout-item',
            children: [
              { type: 'paragraph', content: { text: 'See the [Toolkit](/document/link/9) <span style="color:red">now</span>' } },
              { type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [{ type: 'paragraph', content: { text: 'First' } }] }] },
              { type: 'list', listType: 'number', children: [{ type: 'listitem', children: [{ type: 'paragraph', content: { text: 'Step' } }] }] },
            ],
          },
        ],
      },
      { type: 'alert-component', children: [{ type: 'paragraph', content: { text: '**Heads up**' } }, { type: 'paragraph', content: { text: 'Line two' } }] },
      {
        type: 'collapsible-container',
        title: { type: 'paragraph', content: { text: '**What is it?**' } },
        text: { children: [{ type: 'paragraph', content: { text: 'An answer.' } }] },
      },
      { type: 'button', url: 'https://forms.example.com/r', text: { content: { text: 'Request Now' } } },
      { type: 'button', url: '', text: { content: { text: 'No link' } } },
      { type: 'image', src: '/imageRedirect/42', altText: { content: { text: 'Diagram' } } },
      { type: 'horizontalrule' },
      { type: 'horizontalrule' },
      {
        type: 'cards-container',
        cards: [
          {
            type: 'card',
            title: { children: [{ type: 'styled-paragraph', content: { text: 'FAQs' } }] },
            description: { children: [{ type: 'paragraph', content: { text: '*For managers*' } }] },
            link: { url: '/document/link/11' },
          },
        ],
      },
      { type: 'brand-new-block', content: { text: 'Unknown blocks keep their text' } },
    ],
  };

  it('renders every block type, with absolute links and no inline HTML', () => {
    const md = lexicalToMarkdown(JSON.stringify(doc), O);
    expect(md).toContain('## Resources');
    expect(md).toContain('See the [Toolkit](https://acme.workvivo.us/document/link/9) now');
    expect(md).not.toContain('<span');
    expect(md).toContain('- First');
    expect(md).toContain('1. Step');
    expect(md).toContain('> **Heads up**\n>\n> Line two');
    expect(md).toContain('**What is it?**\n\nAn answer.');
    expect(md).toContain('[Request Now](https://forms.example.com/r)');
    expect(md).toContain('No link');
    expect(md).toContain('![Diagram](https://acme.workvivo.us/imageRedirect/42)');
    expect(md).toContain('**[FAQs](https://acme.workvivo.us/document/link/11)**\n\n*For managers*');
    expect(md).toContain('Unknown blocks keep their text');
    expect(md.match(/^---$/gm)?.length).toBe(1);
  });

  it('accepts an object, a root-children document, and survives bad JSON', () => {
    expect(lexicalToMarkdown({ blocks: [{ type: 'paragraph', content: { text: 'hi' } }] }, O)).toBe('hi');
    expect(lexicalToMarkdown({ root: { children: [{ type: 'paragraph', content: { text: 'r' } }] } }, O)).toBe('r');
    expect(lexicalToMarkdown('{not json', O)).toBe('');
  });
});

describe('extractLinks', () => {
  it('classifies pages, global pages, documents, files, in-app and external links, with context', () => {
    const md = [
      '#### People Leader Resources',
      '[Mid-Year FAQ →](https://acme.workvivo.us/document/link/1)',
      '[ES](https://acme.workvivo.us/document/link/2) | [PT](https://acme.workvivo.us/document/link/3)',
      '**Hiring Toolkit**',
      '[View](https://acme.workvivo.us/document/link/4)',
      '[Goals](https://acme.workvivo.us/spaces/5/pages/goal-setting) [Year-End](https://acme.workvivo.us/pages/248/year-end)',
      '[Attachment](https://acme.workvivo.us/file/77) [Profile](https://acme.workvivo.us/directory/people/9) [Ext](https://example.com/x)',
      '![img](https://acme.workvivo.us/img/x.png) [Again](https://acme.workvivo.us/document/link/1)',
    ].join('\n\n');
    const links = extractLinks(md, O);
    const by = (url: string) => links.find((l) => l.url === url)!;
    expect(by(`${O}/document/link/1`)).toMatchObject({ kind: 'document', document_id: 1, text: 'Mid-Year FAQ →', context: 'People Leader Resources' });
    expect(by(`${O}/document/link/2`)).toMatchObject({ document_id: 2, context: 'Mid-Year FAQ (ES)' });
    expect(by(`${O}/document/link/3`).context).toBe('Mid-Year FAQ (PT)');
    expect(by(`${O}/document/link/4`)).toMatchObject({ text: 'View', context: 'Hiring Toolkit' });
    expect(by(`${O}/spaces/5/pages/goal-setting`)).toMatchObject({ kind: 'page', space_id: 5, page: 'goal-setting' });
    expect(by(`${O}/pages/248/year-end`)).toMatchObject({ kind: 'page', page_group_id: 248, page: 'year-end' });
    expect(by(`${O}/file/77`).kind).toBe('file');
    expect(by(`${O}/directory/people/9`).kind).toBe('workvivo');
    expect(by('https://example.com/x').kind).toBe('external');
    expect(links.filter((l) => l.url === `${O}/document/link/1`)).toHaveLength(1);
    expect(links.some((l) => l.url.endsWith('x.png'))).toBe(false);
  });
});

describe('helpers', () => {
  it('rebaseHeadings keeps structure and moves the smallest level to `top`', () => {
    expect(rebaseHeadings('#### A\n\n##### B\n\ntext', 2)).toBe('## A\n\n### B\n\ntext');
    expect(rebaseHeadings('## A\n\n###### B', 4)).toBe('#### A\n\n###### B');
    expect(rebaseHeadings('no headings', 3)).toBe('no headings');
  });
  it('tidyMarkdown strips nbsp/zero-width, blank runs and duplicate rules', () => {
    expect(tidyMarkdown('a b​  \n\n\n\n---\n\n---\n\nc\n\n---')).toBe('a b\n\n---\n\nc');
  });
  it('absolutize only rewrites root-relative paths', () => {
    expect(absolutize('/x', O)).toBe(`${O}/x`);
    expect(absolutize('//evil.example.com/x', O)).toBe('//evil.example.com/x');
    expect(absolutize('https://a.b/c', O)).toBe('https://a.b/c');
  });
});
