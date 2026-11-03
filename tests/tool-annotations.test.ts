import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor } from './helpers.js';

/**
 * Fleet annotation meta-test, read off the wire (tools/list). workvivo-mcp is
 * read-only: every tool must say so explicitly, none may claim to be
 * destructive, and all reach Workvivo (open world). A future write must be
 * added to the "writes" assertion on purpose, with a confirmWrite gate and an
 * explicit boolean destructiveHint.
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
    expect(Object.keys(ann)).toHaveLength(19);
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

  it('has no writes', () => {
    expect(Object.entries(ann).filter(([, a]) => a?.readOnlyHint !== true).map(([n]) => n)).toEqual([]);
  });
});
