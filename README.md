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
| `WORKVIVO_DOWNLOAD_DIR` | no | Where linked documents are saved (default `~/Downloads/workvivo-mcp`). |
| `WORKVIVO_MAX_DOWNLOAD_MB` | no | Documents larger than this are skipped, not downloaded (default `50`). |
| `WORKVIVO_SKIP_FILE_TYPES` | no | Comma-separated extensions or MIME types never downloaded, e.g. `mp4,.mov,video/*` (default `video/*,audio/*`; `none` skips nothing). |

## Tools

| Tool | What it reads |
|---|---|
| `workvivo_healthcheck` | Bridge, extension pairing and Workvivo sign-in, end to end |
| `workvivo_get_feed` | Home feed, a space's feed, or a person's posts |
| `workvivo_list_news` / `workvivo_get_article` | News articles; one article with its body as text |
| `workvivo_get_post` / `workvivo_list_shoutouts` | A post or shoutout; recent shoutouts |
| `workvivo_get_comments` | Comments on a post, article, event or shoutout, with names |
| `workvivo_get_question` | A Q&A question with its answers, votes and the accepted answer |
| `workvivo_list_events` / `workvivo_get_event` | Upcoming events (UTC times, RSVP state); one event |
| `workvivo_search_people` / `workvivo_get_person` | The directory; a profile (role, manager, bio) |
| `workvivo_get_me` / `workvivo_get_my_team` | You; your team |
| `workvivo_list_pages` / `workvivo_get_page` | A space's (or global collection's) page tree; one page as **Markdown**, with an index of the pages and documents it links to |
| `workvivo_get_document` | A linked document (PDF, Word, text, HTML) as Markdown — the browser downloads it through your session |
| `workvivo_digest_space` | A whole space in one Markdown document: every page, the linked-document index, library, events, recent posts (optionally the documents' text) |
| `workvivo_list_spaces` / `workvivo_get_space` | Your spaces, all spaces, trending, or by name; one space |
| `workvivo_list_notifications` | Notifications and unread counts |
| `workvivo_search` | Full-text search across articles, posts, events, people, spaces and docs |
| `workvivo_api_get` | Any other read-only `/api/` path (action-style paths refused) |

Read tools return a compact projection by default. Pass `view: "full"` for Workvivo's
record as sent. Credential-shaped fields, such as meeting passcodes and realtime
tokens, are redacted in every view. `workvivo_list_notifications` and
`workvivo_list_events` also take `view: "brief"` — one line per item
(`title — <UTC time | no date> — <status>`, at most 120 characters) in the
untrusted-data envelope, with `-- ` note lines for an empty or partial page — and
carry context-group hints (`_meta.mint`, group `work`) for hosts that read them. Note that `workvivo_search` adds the query to your
own Workvivo search history.

**Documents** (`workvivo_get_document`, and `workvivo_digest_space` with
`include_documents`): Workvivo's document links redirect to a short-lived signed URL
on your tenant's file host. The bridge captures that URL as your browser follows the
link, so nothing is downloaded by the browser. The server then checks the file
**type** (from its name) against `WORKVIVO_SKIP_FILE_TYPES` before any request, and
its **size** against `WORKVIVO_MAX_DOWNLOAD_MB` before reading the body. Files that
pass are saved, never overwriting, in `WORKVIVO_DOWNLOAD_DIR`. If the capture isn't
available, the browser downloads the file instead; the same rules then apply to it,
and it is moved into `WORKVIVO_DOWNLOAD_DIR`. This needs a pairing that includes the
`capture_redirect` and `download` permissions. If you paired an earlier version,
remove workvivo-mcp in the ContextMint Bridge popup and approve the new pair code.

Documents can't be read on a **hosted** server (mcp-host) yet. The file host is
outside the server's allowed network hosts, and the browser bridge can't return file
contents. `workvivo_get_document` refuses with that reason before making any request,
and `workvivo_digest_space` lists each linked document as not fetched while returning
the rest of the space. Use a local install to read documents.

The endpoints and their quirks are documented in [`docs/WORKVIVO-API.md`](docs/WORKVIVO-API.md).

## Upgrading

### next release

On a hosted server, document reads (`workvivo_get_document`, and
`workvivo_digest_space` with `include_documents`) now refuse with a clear message
instead of failing on the network. The digest still returns everything else and
marks each document as not fetched. A local install is unchanged.

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
