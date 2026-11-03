#!/usr/bin/env node
// workvivo-mcp entrypoint.
//
// Workvivo tenants sit behind corporate SSO (SAML), so there is no
// server-side login: every request rides the user's already-signed-in
// `<org>.workvivo.<tld>` tab, relayed through the ContextMint Bridge browser
// extension over the shared fetchproxy concentrator port (default 37149).
//
// Boot: build the transport + client once (outside runMcp — its factory runs
// per served connection), load the bridge identity with start() BEFORE stdio
// connects, then serve. Missing or malformed config does NOT block boot: the
// server still answers tools/list, and the error surfaces on the first call.
import { readPortEnv, requireEnvVar, runMcp } from '@chrischall/mcp-utils';
import { WorkvivoClient, WorkvivoConfigError, normalizeHost } from './client.js';
import { DEFAULT_PORT, FetchproxyTransport } from './transport-fetchproxy.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerFeedTools } from './tools/feed.js';
import { registerNewsTools } from './tools/news.js';
import { registerPostTools } from './tools/posts.js';
import { registerEventTools } from './tools/events.js';
import { registerPeopleTools } from './tools/people.js';
import { registerSpaceTools } from './tools/spaces.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerSearchTools } from './tools/search.js';
import { registerQuestionTools } from './tools/questions.js';
import { registerRawTools } from './tools/raw.js';
import { VERSION } from './version.js';

let configError: WorkvivoConfigError | undefined;
let host: string | undefined;
try {
  // Required for every data call — read with requireEnvVar, but caught, so a
  // missing host is a deferred error on the first call, not a boot failure.
  host = normalizeHost(requireEnvVar('WORKVIVO_HOST'));
} catch (e) {
  configError =
    e instanceof WorkvivoConfigError ? e : new WorkvivoConfigError('WORKVIVO_HOST is not set.');
}
let port = DEFAULT_PORT;
try {
  port = readPortEnv('WORKVIVO_WS_PORT', DEFAULT_PORT);
} catch (e) {
  configError ??= new WorkvivoConfigError((e as Error).message);
}

const transport = new FetchproxyTransport({ port, host, version: VERSION });
const client = new WorkvivoClient({ transport, host, configError });
await client.start();

await runMcp({
  name: 'workvivo-mcp',
  version: VERSION,
  deps: client,
  tools: [
    (server) => registerHealthcheckTools(server, client),
    (server) => registerFeedTools(server, client),
    (server) => registerNewsTools(server, client),
    (server) => registerPostTools(server, client),
    (server) => registerEventTools(server, client),
    (server) => registerPeopleTools(server, client),
    (server) => registerSpaceTools(server, client),
    (server) => registerNotificationTools(server, client),
    (server) => registerSearchTools(server, client),
    (server) => registerQuestionTools(server, client),
    (server) => registerRawTools(server, client),
  ],
  banner:
    `[workvivo-mcp] v${VERSION} — fetchproxy bridge on 127.0.0.1:${port}. Install ContextMint Bridge ` +
    `(https://github.com/nullnet-app/contextmint-bridge), sign in to https://${client.hostLabel} in that ` +
    'browser, and set WORKVIVO_HOST. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
