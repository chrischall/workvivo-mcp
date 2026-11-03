import { toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';

/** A Workvivo numeric id (articles, posts, people, spaces, events). */
export const idArg = (what: string) =>
  z.coerce.number().int().positive().describe(`The ${what} id (a number — find it with a list or search tool).`);

/** A 1-based Laravel page number. */
export const pageArg = z.coerce.number().int().positive().max(1000).optional().describe('Page number (default 1).');

/** Every tool here only reads Workvivo, through the user's browser session. */
export const readAnnotations = (title: string) =>
  toolAnnotations({ title, readOnly: true, idempotent: true, openWorld: true });
