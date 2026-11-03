import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor } from './helpers.js';

/**
 * Fleet annotation meta-test, read off the wire (tools/list). workvivo-mcp
 * never changes anything in Workvivo. Two tools are not read-only only because
 * they make the BROWSER save a linked document on this machine
 * (workvivo_get_document, and workvivo_digest_space with include_documents) —
 * additive and never overwriting, so destructiveHint must be an explicit
 * false. Any other non-read must be added to that list on purpose (a write to
 * Workvivo would also need a confirmWrite gate).
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let h: Awaited<ReturnType<typeof harnessFor>>;
let ann: Record<string, Ann | undefined>;

beforeAll(async () => {
  h = await harnessFor();
  ann = Object.fromEntries(
    (await h.harness.client.listTools()).tools.map((t) => [t.name, t.annotations as Ann | undefined]),
  );
});
afterAll(async () => {
  await h?.harness.close();
});

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped)', () => {
    expect(Object.keys(ann)).toHaveLength(23);
  });

  it('sets an explicit boolean readOnlyHint on every tool', () => {
    expect(Object.entries(ann).filter(([, a]) => typeof a?.readOnlyHint !== 'boolean').map(([n]) => n)).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(ann)
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    expect(Object.entries(ann).filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true).map(([n]) => n)).toEqual([]);
  });

  it('marks every tool open-world (all reach Workvivo through the browser bridge)', () => {
    expect(Object.entries(ann).filter(([, a]) => a?.openWorldHint !== true).map(([n]) => n)).toEqual([]);
  });

  it('has no writes — only the two local-download tools are non-reads, and both are additive', () => {
    const nonReads = Object.entries(ann).filter(([, a]) => a?.readOnlyHint !== true);
    expect(nonReads.map(([n]) => n).sort()).toEqual(['workvivo_digest_space', 'workvivo_get_document']);
    expect(nonReads.map(([, a]) => a?.destructiveHint)).toEqual([false, false]);
  });
});
