import type { McpServer } from '@modelcontextprotocol/server';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import { WorkvivoConfigError, WorkvivoSessionError, type WorkvivoClient } from '../client.js';

/**
 * `workvivo_healthcheck` — one call that says which hop is broken: the
 * fetchproxy bridge, the ContextMint Bridge extension, or the signed-in
 * Workvivo tab. Every request rides the bridge, so this is the bridge
 * healthcheck; the probe goes through the real client path (CSRF handshake
 * included) against the tiny unread-counts endpoint.
 */
export const PROBE_PATH = '/api/notifications/unread';

/** Name the Workvivo-specific failures; anything else is the bridge's to classify. */
export function classifyWorkvivoError(err: unknown): { kind: string; hint: string } | undefined {
  if (err instanceof WorkvivoConfigError) return { kind: 'not_configured', hint: err.message };
  if (err instanceof WorkvivoSessionError) return { kind: 'session_expired', hint: err.hint ?? err.message };
  return undefined;
}

export function registerHealthcheckTools(server: McpServer, client: WorkvivoClient): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'workvivo',
    probePath: PROBE_PATH,
    hostLabel: client.hostLabel,
    transport: {
      runProbe: (fetchFn, path) => client.runProbe(fetchFn, path),
      status: () => client.bridgeStatus(),
    },
    probeFn: () => client.get('notifications/unread'),
    classifyThrown: classifyWorkvivoError,
  });
}
