import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor } from './helpers.js';

/**
 * Things that otherwise fail only once a tag exists: provenance needs
 * `repository.url`; `files` must ship the skills and mint.yaml (an npm-sourced
 * mcp-host registration reads the TARBALL); manifest.json's tool roster must
 * match what the server registers, in both directions, or an mcpb host never
 * shows the missing tool.
 */
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const pkg = read('../package.json') as {
  name: string;
  repository: { url: string };
  files: string[];
  bin: Record<string, string>;
};

let registered: Array<{ name: string; description?: string }>;
let h: Awaited<ReturnType<typeof harnessFor>>;
beforeAll(async () => {
  h = await harnessFor();
  registered = (await h.harness.client.listTools()).tools;
});
afterAll(async () => {
  await h?.harness.close();
});

describe('packaging', () => {
  it('declares the repository for npm provenance', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/chrischall/workvivo-mcp.git');
  });

  it('ships the skills and mint.yaml in the npm tarball', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'skills', 'mint.yaml', 'server.json', '.claude-plugin', '.mcp.json']));
  });

  it('has a single bin pointing at the bundle', () => {
    expect(pkg.bin).toEqual({ 'workvivo-mcp': 'dist/bundle.js' });
  });

  it('manifest.json lists exactly the registered tools, each with a description', () => {
    const manifest = read('../manifest.json') as { tools: Array<{ name: string; description: string }> };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(registered.map((t) => t.name).sort());
    expect(manifest.tools.filter((t) => !t.description.trim())).toEqual([]);
  });

  it('every registered tool has a description', () => {
    expect(registered.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
  });

  it('server.json description fits the registry limit', () => {
    expect((read('../server.json') as { description: string }).description.length).toBeLessThanOrEqual(100);
  });
});
