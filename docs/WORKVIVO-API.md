# Workvivo internal API — what this server relies on

Workvivo (Zoom Workvivo) has a documented public API, but it needs an
organization-admin-issued token an employee does not have. What an employee can
reach is the web app's own internal API under `https://<org>.workvivo.<tld>/api/`,
which the SPA calls with axios (`baseURL: "/api/"`). Every shape below was
captured live on 2026-11-03 through a signed-in tab; values in this repo's
fixtures are synthetic.

## Authentication

- Workvivo is a Laravel app behind SAML SSO (`/login` → `/saml/sso` → the IdP).
  There is no server-side login, so every request rides the browser tab via the
  fetchproxy bridge.
- `/api/*` routes authenticate with the browser's session cookies **plus** a CSRF
  header. Without the header, every route — GETs included — answers
  `401 {"message":"Unauthenticated."}`.
- The header is `X-CSRF-Token: <token>`, where `<token>` is
  `<meta name="csrf_token" content="…">` in the SPA shell. The SPA also sends
  `X-Requested-With: XMLHttpRequest`. The token is per session.
- Every HTML route returns the same ~600 KB shell (with the token), so there is
  no cheaper place to read it. The `XSRF-TOKEN` cookie does NOT work as a
  substitute: sent as `X-XSRF-TOKEN` it gives `401` decoded and `500` raw.
- Signed out: the shell redirects to `/saml/sso` and then off-host to the IdP.

## Endpoints (all GET unless noted)

| Purpose | Path | Paging | Notes |
|---|---|---|---|
| Signed-in user | `user` | — | ~80 KB; carries `realtimeEventsToken`, analytics keys, org settings. Allowlist-project only. |
| Unread counts | `notifications/unread` | — | `{notifications, pulse, chat}` |
| Notifications | `notifications?page=N` | Laravel | Listing does not mark read (unread count unchanged after). `type` is `App\Notifications\<Kind>`; `data` = `{id, type, title}`. |
| Home feed | `activity[?next_cursor=…]` | cursor (`next_cursor`) | 5 per page. Rows wrap `item` by `item_type`: `update`, `article`, `event`, `kudos`, `question-post`. |
| Space feed | `spaces/<id>/feed[?next_cursor=…]` | cursor | `spaces/<id>/activity` is a 404. |
| Person's feed | `people/<id>/feed?page=N&removenoise=true` | Laravel | |
| News | `articles?page=N` | Laravel (5) | `links`/`meta` + `next_page_url` |
| Featured news | `articles/featured` | — | bare array |
| Space news | `spaces/<id>/news?page=N&type=published` | Laravel | ~1 MB raw per page |
| Article | `articles/<id>` | — | body in `html_content`; `language_variants` is ~64 KB |
| Related | `articles/read-more/<id>` | — | |
| Post | `updates/<id>` | — | `text` (plain) + `html` |
| Shoutouts | `kudos?page=N`, `kudos/<id>` | Laravel | giver in `giver`, recipients in `user_mentions[].user` |
| Comments | `comments/<type>/<id>` | — | bare array; `type` ∈ `update article event kudos` (verified). Carries `user_id` only. Question posts use answers, not comments. |
| Likes | `likedby/<type>/<id>` | — | `{default:[names]}` |
| Q&A question | `question-posts/<id>` | — | body is HTML; `accepted_answer` object. Viewing is counted by a separate `POST …/log-view`, never sent. |
| Q&A answers | `question-posts/<id>/answers?page=N` | Laravel | `accepted`, `votes`, `user`, HTML `body` |
| Events | `events/listings?page=N` | Laravel (5) | `*_utc` fields, `is_going`, `permalink` |
| Upcoming | `events/upcoming` | — | bare array |
| Space events | `spaces/<id>/events?page=N` | Laravel | |
| Event | `events/show/<id>` | — | `events/<id>` is a 500. Carries `zoom_webinar_password`. |
| People search | `people?page=N&query=…&includeExternal=true` | Laravel (24) | `all` = directory total |
| Person | `people/<id>` | — | includes `mobile_phone`, `direct_dial`, `birthday`, `manager`, `manages`, `profile.{short_bio,expertise,interests}` |
| Your team | `people/my/team` | — | bare array |
| Spaces (mine) | `spaces?page=N&type=my&pageSize=50` | Laravel | |
| Spaces (all) | `spaces?page=N` | Laravel (15) | `type=all` ignores `query` |
| Space search | `spaces?page=N&type=search&query=…` | Laravel | |
| Trending | `spaces/trending` | — | bare array |
| Space | `spaces/<id>?info=1` | — | `spaces/<id>/members` is 403 unless you own it |
| Departments / locations | `terms/departments`, `terms/locations`, `terms/<id>/people?page=N` | | |
| Quick name search | `search/<term>?v2=1` | — | `{people, teams, goals, spaces}` |
| **Federated search** (POST) | `federated-search` | `page` in body | Body `{page, query, types:[…]}`; an unknown type is a 422. Results `{current_page, last_page, data:[{id, type, title (with <strong>), url, updated_at, details:{author, text}}]}`. Side effect: records the query in the user's search history. |

## Pages and documents

| Purpose | Path | Notes |
|---|---|---|
| Space page tree | `spaces/<id>/pages-v2?include_content=false` | `{page (landing), pages:[{id,title,slug,is_draft,children:[…]}]}` |
| Space page | `spaces/<id>/pages/<slug>?include_content=true` | addressed by **slug**, not id (`pages/59817` → "No query results"); some slugs are the id. No slug = the landing page. |
| Global page tree | `pages-v2/<group>?include_content=false` | "page collections" (`page_group_id`) |
| Global page | `pages/<group>/<slug>?include_content=true` | |
| Space document library | `spaces/<id>/documents?page=N` | Laravel pages of 12 |
| Space useful links | `spaces/<id>/links` | `{title, body (HTML)}` |

Pages are written in one of two editors:

- `editor_type: "tinymce"`: HTML in `html_content`, laid out with Bootstrap grid
  divs. Images are on **signed** CloudFront URLs (`Expires`/`Signature`), which are
  never emitted.
- `editor_type: "lexical"`: `html_content` is empty, and `json_content` is a JSON
  string `{blocks:[…]}`. Each block's `content.text` is already Markdown, with
  occasional inline `<span style>` tags. Block types seen: paragraph,
  styled-paragraph, heading, list/listitem, layout-container/-item,
  alert-component, collapsible-container, button, image, card/cards-container and
  horizontalrule.

**Documents** are linked as `/document/link/<id>` (and `/file/<id>`). These are
server routes, not `/api`, and they 302 to a signed URL on the file host
(`attachments.workvivo.us`):
`…/uploads/<org>/<user>/<hash>.pdf?response-content-disposition=filename%3D%22<name>%22&Expires=<~15 s>&Signature=…&Key-Pair-Id=…`.
A page `fetch` fails ("Failed to fetch", because the file host sends no CORS
headers). Two ways through:

- **capture_redirect**, used first: the browser follows the link and the bridge
  reports the redirect target. That signed URL works from the server with no
  cookies, and a `HEAD` gives `Content-Length`, `Content-Type` and
  `Content-Disposition`. It has to be used within seconds.
- **download**, the fallback: `chrome.downloads` follows the redirect and saves the
  file in the browser's download folder. Note that `documents/<id>` in the API is a *different* id space: a link id
there answers "No query results". The `download` capability has to be in the
pairing, and the extension refuses (rather than re-prompting) a pairing approved
without it.

## Times

Every timestamp is UTC, in `YYYY-MM-DD HH:MM:SS` form. Checked against the `*_utc`
twins on events and the relative labels (`human_formatted_created_at`) on feed rows.

## GETs that change state (refused by `workvivo_api_get`)

The SPA calls a few state-changing endpoints with GET, for example
`spaces/<id>/update-last-visited`, `spaces/<id>/export/members`,
`livestreams-v2/<id>/download` and `events/zoom/passcode`. `src/tools/raw.ts`
refuses action-named segments like these.
