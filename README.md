# workvivo-mcp

Read-only [Workvivo](https://www.workvivo.com/) MCP server for Claude. It covers your
company's activity feed, news articles, posts and shoutouts with their comments,
events, the people directory, spaces, notifications and full-text search.

> This project was developed and is maintained by AI (Claude Code). Use at your own discretion.

## How it works

Workvivo sits behind your company's single sign-on, and its public API needs an
admin-issued token. This server therefore makes no requests of its own. Every request
runs in **your already-signed-in Workvivo browser tab**, relayed by the
[ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge) extension over
the fetchproxy bridge (`127.0.0.1:37149`). Each request is a same-origin fetch in your
tab, with your session and your permissions. The server reads; it never posts, likes,
comments, RSVPs or marks anything read.

## Setup

1. Install the ContextMint Bridge extension and sign in to your Workvivo site
   (e.g. `https://acme.workvivo.us`) in that browser.
2. Add the server to your MCP client:

   ```json
   {
     "mcpServers": {
       "workvivo": {
         "command": "npx",
         "args": ["-y", "workvivo-mcp"],
         "env": { "WORKVIVO_HOST": "acme.workvivo.us" }
       }
     }
   }
   ```

3. Call `workvivo_healthcheck`. On the first run it returns a pair code. Approve it
   in the ContextMint Bridge popup (once; the trust persists).

| Variable | Required | |
|---|---|---|
| `WORKVIVO_HOST` | yes | Your organization's Workvivo host, e.g. `acme.workvivo.us`. |
| `WORKVIVO_WS_PORT` | no | Override the fetchproxy WebSocket port (default 37149). |
| `WORKVIVO_DEBUG` | no | Set to `1` to log verbose request detail to stderr. |

## Tools

| Tool | What it reads |
|---|---|
| `workvivo_healthcheck` | Bridge, extension pairing and Workvivo sign-in, end to end |
| `workvivo_get_feed` | Home feed, a space's feed, or a person's posts |
| `workvivo_list_news` / `workvivo_get_article` | News articles; one article with its body as text |
| `workvivo_get_post` / `workvivo_list_shoutouts` | A post or shoutout; recent shoutouts |
| `workvivo_get_comments` | Comments on a post, article, event or shoutout, with names |
| `workvivo_list_events` / `workvivo_get_event` | Upcoming events (UTC times, RSVP state); one event |
| `workvivo_search_people` / `workvivo_get_person` | The directory; a profile (role, manager, bio) |
| `workvivo_get_me` / `workvivo_get_my_team` | You; your team |
| `workvivo_list_spaces` / `workvivo_get_space` | Your spaces, all spaces, trending, or by name; one space |
| `workvivo_list_notifications` | Notifications and unread counts |
| `workvivo_search` | Full-text search across articles, posts, events, people, spaces and docs |
| `workvivo_api_get` | Any other read-only `/api/` path (action-style paths refused) |

Read tools return a compact projection by default. Pass `view: "full"` for Workvivo's
record as sent. Credential-shaped fields, such as meeting passcodes and realtime
tokens, are redacted in every view. Note that `workvivo_search` adds the query to your
own Workvivo search history.

The endpoints and their quirks are documented in [`docs/WORKVIVO-API.md`](docs/WORKVIVO-API.md).

## Without the server: the `workvivo-fpx` skill

[`skills/workvivo-fpx`](skills/workvivo-fpx/SKILL.md) gives the same read access from a
shell, using the [`fpx`](https://www.npmjs.com/package/@fetchproxy/cli) CLI and a
sourceable helper (`scripts/wv.sh`), with ready-made `jq` recipes for each endpoint.

## Development

```sh
npm install
npm run build   # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test        # typecheck + vitest (all mocked; no network)
```

## License

MIT
