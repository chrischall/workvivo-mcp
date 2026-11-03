import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractDocument, formatOf, windowOf } from '../src/documents.js';

const O = 'https://acme.workvivo.us';
const dir = mkdtempSync(join(tmpdir(), 'workvivo-docs-'));
const file = (name: string, data: string | Uint8Array) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

/** A minimal, valid single-page PDF whose text layer says `text` (synthetic). */
function makePdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => {
      const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A minimal .docx with a heading, a paragraph and a bullet-less list (synthetic). */
async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Onboarding Guide</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Day one:</w:t></w:r><w:r><w:t xml:space="preserve"> meet your team.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('formatOf / windowOf', () => {
  it('picks the extractor from extension, then mime', () => {
    expect(formatOf('/d/a.PDF')).toBe('pdf');
    expect(formatOf('/d/a', 'application/pdf')).toBe('pdf');
    expect(formatOf('/d/a.docx')).toBe('docx');
    expect(formatOf('/d/a.htm')).toBe('html');
    expect(formatOf('/d/a.csv')).toBe('text');
    expect(formatOf('/d/a.bin', 'text/plain')).toBe('text');
    expect(formatOf('/d/a.pptx')).toBe('unsupported');
  });
  it('windows text and reports where the next window starts', () => {
    expect(windowOf('abcdef', 0, 4)).toEqual({ text: 'abcd', total: 6, next_offset: 4 });
    expect(windowOf('abcdef', 4, 4)).toEqual({ text: 'ef', total: 6 });
    expect(windowOf('abc', 99, 4)).toEqual({ text: '', total: 3 });
  });
});

describe('extractDocument', () => {
  it('extracts a PDF text layer, page-marked', async () => {
    const out = await extractDocument(file('guide.pdf', makePdf('Synthetic PDF body')), 'application/pdf', O);
    expect(out).toMatchObject({ format: 'pdf', pages: 1 });
    expect(out.text).toContain('<!-- page 1 -->');
    expect(out.text).toContain('Synthetic PDF body');
  });

  it('notes a PDF with no text layer instead of returning nothing', async () => {
    const out = await extractDocument(file('scan.pdf', makePdf('')), undefined, O);
    expect(out.text).toBeUndefined();
    expect(out.note).toMatch(/no text layer/);
  });

  it('converts a .docx to Markdown', async () => {
    const out = await extractDocument(file('guide.docx', await makeDocx()), undefined, O);
    expect(out.format).toBe('docx');
    expect(out.text).toContain('# Onboarding Guide');
    expect(out.text).toContain('**Day one:** meet your team.');
  });

  it('passes text through, converts HTML, and declines unsupported types', async () => {
    expect((await extractDocument(file('n.csv', 'a,b\n1,2'), undefined, O)).text).toBe('a,b\n1,2');
    expect((await extractDocument(file('p.html', '<h2>Hi</h2><p><a href="/file/3">f</a></p>'), undefined, O)).text).toBe(
      '## Hi\n\n[f](https://acme.workvivo.us/file/3)',
    );
    const ppt = await extractDocument(file('deck.pptx', 'PK'), undefined, O);
    expect(ppt.text).toBeUndefined();
    expect(ppt.note).toMatch(/open the saved file/);
  });

  it('refuses something that is not a regular file', async () => {
    await expect(extractDocument(dir + '/', 'text/plain', O)).rejects.toThrow(/not a regular file/);
  });
});
