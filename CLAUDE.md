# CLAUDE.md — workvivo-mcp

Read-only MCP server for Workvivo, fetchproxy archetype (full bridge). Every
request rides the user's signed-in `<org>.workvivo.<tld>` tab, because Workvivo
is behind SAML SSO and its public API needs an admin token.

## What is true only of this repo

- **CSRF handshake.** `/api/*` needs `X-CSRF-Token` (from `<meta name="csrf_token">`
  in the ~600 KB SPA shell) and `X-Requested-With`, on GETs too. `src/client.ts`
  reads it once (single-flight), re-reads on 401/419, and retries exactly once.
  The `XSRF-TOKEN` cookie is not a substitute; this was verified, so don't
  "optimise" the client onto it.
- **Read-only by design.** There are no write tools. `workvivo_search` is a POST
  but read-only, and is sent with `retryOnTimeout: true`.
  `workvivo_api_get` refuses action-named path segments, because Workvivo has
  state-changing GETs (`update-last-visited`, `export`, `download`). Adding a
  write means a confirm-gated tool and updating `tests/tool-annotations.test.ts`
  on purpose.
- **Redaction on every rung.** `redactSensitive` (src/project.ts) runs on both
  `compact` and `full`, because events carry `zoom_webinar_password` and `user`
  carries realtime/analytics tokens. Compact projections are allowlists, so
  phones and birthdays never leave `workvivo_get_person` compact. The `brief`
  rung (src/brief.ts, the two canonical reads only) is built from those same
  allowlist projections — title, time and read/RSVP state — so it carries no
  field redaction would have to remove.
- **Context-group hints** (`src/tools/hints.ts`): every tool but the healthcheck
  carries `_meta.mint` with domain `work`; `tests/mint-hints.test.ts` holds the
  intent table, so a new tool fails it until it declares one. Canonical:
  notifications (whats-new) and events (whats-on); no subject (nothing listable).
- **Pages → Markdown** (`src/markdown.ts`): TinyMCE HTML via turndown (signed media
  URLs dropped, links made absolute, GFM tables), Lexical `{blocks}` via a block
  walker (its text is already Markdown). `extractLinks` classifies every link and
  gives a "View"/"ES" link the heading or document it belongs to.
- **Documents (`src/download.ts`)**: `/document/link/<id>` 302s to a signed URL on
  the tenant's file host (`attachments.<apex>`), which expires in about 15 s. The
  bridge **captures** that redirect (`capture_redirect`: arm the listener, then
  trigger it with a page fetch, which then fails CORS as expected). The server checks
  the type (filename from `response-content-disposition`) against
  `WORKVIVO_SKIP_FILE_TYPES` before any request, and the size via `fetchBounded`'s
  `Content-Length` cap before reading the body. It fetches only hosts on the tenant's
  apex and writes with `writeUniqueFile` into `WORKVIVO_DOWNLOAD_DIR`. The fallback
  is the browser's `download` verb, with the same rules applied to the saved file,
  then a move. **Hosted** (`isHostedEnv`): the same capture, then the BROWSER fetches
  the signed URL through the bridge (`transport.fetchBytes` → fetchproxy `getBytes`,
  from the extension's background worker, `credentials: 'omit'`) and returns the bytes
  (`fetchSignedViaBridge`, outcome `fetched`, held in memory, the last 4 cached for
  paging). Same host and type rules; `content-length`/`content-type` are checked
  before the body is used; the cap is `min(WORKVIVO_MAX_DOWNLOAD_MB, 16 MiB)` and an
  over-cap file is a `skipped` with size and cap. There is no browser-download fallback
  hosted. `workvivo_get_document` delivers the file as a blob-store link (`deliverFile`,
  minted once per document). Errors: an extension older than ContextMint Bridge 1.8.0
  → `ExtensionUpdateRequiredError` (update it; re-pairing does not help — the digest
  marks the rest "Not fetched" without asking again); `response_too_large` →
  `BridgeResponseTooLargeError` → a skip; a final URL off the apex → a clear refusal
  (`mapBytesError`). mint.yaml `egress` stays empty: the bytes never touch this
  process's network. **Pairing domains stay `[apex]`**: the file host
  (`attachments.<apex>`) is a subdomain of it, and the extension compares domains as a
  SET, so adding an entry would send every existing pairing back through a re-pair
  prompt for no extra reach. Capabilities: `['fetch','capture_redirect','download']`. An older
  pairing is *refused*, not re-prompted; `mapDownloadError` turns that into the
  re-pair remedy. Tests use `testPolicy()` (a temp dir) and must never touch
  `~/Downloads`. pdf.js writes warnings to STDOUT (the JSON-RPC channel):
  `extractPdf` passes `verbosity: 0`, so keep it.
- **Times are UTC.** Workvivo's `YYYY-MM-DD HH:MM:SS` stamps are UTC (verified
  against `*_utc` twins); `utcIso` adds the `Z`.
- **Fixtures are synthetic.** `tests/fixtures.ts` mirrors live shapes with invented
  values. Never paste a captured response into the repo: they hold colleagues'
  names, emails and internal posts.
- Endpoint notes: `docs/WORKVIVO-API.md`. Shell access with no server:
  `skills/workvivo-fpx/` (its `scripts/wv.sh` avoids the variable name `path`,
  which is tied to `$PATH` in zsh).

## Commands

`npm run build` (tsc --noEmit + esbuild bundle) · `npm test` (typecheck + vitest)
· `node ~/git/mcp-utils/scripts/audit-annotations.mjs dist/bundle.js --strict`
(the entry file comes FIRST; CI runs this).

Logging goes to stderr only; stdout is the JSON-RPC channel.
