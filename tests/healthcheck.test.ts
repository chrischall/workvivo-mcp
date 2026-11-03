import { afterEach, describe, expect, it } from 'vitest';
import { WorkvivoApiError, WorkvivoConfigError, WorkvivoSessionError } from '../src/client.js';
import { classifyWorkvivoError, PROBE_PATH } from '../src/tools/healthcheck.js';
import { HOST, harnessFor } from './helpers.js';

describe('classifyWorkvivoError', () => {
  it('names a missing host as not_configured', () => {
    expect(classifyWorkvivoError(new WorkvivoConfigError('WORKVIVO_HOST is not set.'))).toEqual({
      kind: 'not_configured',
      hint: 'WORKVIVO_HOST is not set.',
    });
  });

  it('names a signed-out browser as session_expired, with the sign-in remedy', () => {
    const out = classifyWorkvivoError(new WorkvivoSessionError(HOST, 'no session token on the home page'));
    expect(out?.kind).toBe('session_expired');
    expect(out?.hint).toContain(`https://${HOST}`);
  });

  it('leaves everything else to the bridge classifier', () => {
    expect(classifyWorkvivoError(new WorkvivoApiError('boom', 500))).toBeUndefined();
    expect(classifyWorkvivoError(new Error('bridge down'))).toBeUndefined();
  });
});

describe('workvivo_healthcheck', () => {
  let h: Awaited<ReturnType<typeof harnessFor>> | undefined;
  afterEach(async () => {
    await h?.harness.close();
  });

  it('probes the unread-counts endpoint through the real client path (CSRF handshake included)', async () => {
    h = await harnessFor({ [PROBE_PATH]: { notifications: 0, pulse: 0, chat: 0 } });
    await h.harness.client.callTool({ name: 'workvivo_healthcheck', arguments: {} });
    expect(h.transport.calls.map((c) => c.path)).toEqual(['/', PROBE_PATH]);
    expect(h.transport.apiCalls[0]!.headers?.['X-CSRF-Token']).toBeDefined();
  });
});
