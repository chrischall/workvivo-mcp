/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, spec 2026-11-03 D4). Inert data: a host that does not read
 * them sees an extra `_meta` key and nothing else. The shape is fixed by the
 * host's contract, so it is restated here rather than imported — this server
 * takes no dependency on mcp-host.
 *
 * Every tool here is in the `work` group. Two reads are canonical:
 * `workvivo_list_notifications` (what's new for you) and
 * `workvivo_list_events` (what's on). Nothing in Workvivo answers "what's
 * due", and no canonical read names a `subject`: the only listable sets are
 * spaces, which are not a person's subjects.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'work';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  /** Words a person says — lowercase, at most 8, each at most 40 chars. */
  aliases?: string[];
}

/** `_meta` for a Workvivo tool. */
export function workMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'work', intent, ...extra } };
}

/** `_meta` for a plain read that answers a lookup. */
export const LOOKUP = workMeta('lookup');
