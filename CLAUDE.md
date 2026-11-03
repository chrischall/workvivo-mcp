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
  phones and birthdays never leave `workvivo_get_person` compact.
- **Pages → Markdown** (`src/markdown.ts`): TinyMCE HTML via turndown (signed media
  URLs dropped, links made absolute, GFM tables), Lexical `{blocks}` via a block
  walker (its text is already Markdown). `extractLinks` classifies every link and
  gives a "View"/"ES" link the heading or document it belongs to.
- **Documents ride the bridge's `download` verb** (`capabilities: ['fetch','download']`),
  because `/document/link/<id>` 302s to a signed file host. The browser saves the file
  locally and the server reads it, so this works only where both run on one machine.
  An old pairing without `download` is *refused*, not re-prompted;
  `mapDownloadError` turns that into the re-pair remedy. pdf.js writes warnings to
  STDOUT (the JSON-RPC channel): `extractPdf` passes `verbosity: 0`, so keep it.
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
