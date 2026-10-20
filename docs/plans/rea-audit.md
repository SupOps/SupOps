# REA audit of SupOps (Phase 0)

Written 2026-10-16. SupOps was examined as shipped, the way an outsider would see it:
- the built web bundle (`apps/web/dist`), analysed statically;
- the database layout, schema only;
- the app running in a browser.

Everything ran on a demo instance (port 3098, stand-in model, fake SSH and Prometheus, demo data
only).

**REA tools used:**
- `analyze_javascript_application` on the bundle;
- `inspect_sqlite_database` on the schema;
- `capture_browser_scenario`: sign in, then visit Dashboard, Investigate, Runs, a run, Approvals,
  Alerts, Observability, Health, Targets, Knowledge and Settings, then leave the dashboard idle for
  30 seconds. Console, page errors, network and websockets were recorded.

## Findings and fixes

| # | Finding (evidence) | Fix | After |
|---|---|---|---|
| 1 | **No compression.** Responses had no `Content-Encoding`. The app file was 901,584 bytes on the wire. | `compression` middleware (gzip/brotli), threshold 1 KB. | `Content-Encoding: br`. |
| 2 | **Nothing cached between visits.** Everything was served `Cache-Control: public, max-age=0`, so every page load revalidated the 900 KB file. | `/assets/*` (hashed names) get `max-age=31536000, immutable`. `index.html`, the service worker and icons get `no-cache`. | Assets are cached once per release. |
| 3 | **One 900 KB file for every page.** Every page loaded `index-*.js` only. Mermaid was already loaded on demand, contrary to the static guess. | Each page is its own file (`lazyPage`). After a release, a tab left open reloads once if an old page file is gone. | The main file is 310 KB (99 KB compressed). Pages are 1–28 KB. The Markdown renderer (174 KB) loads only on pages that show Markdown. |
| 4 | **No security headers, and Express announced itself.** There was no CSP, `X-Content-Type-Options` or framing protection, and an `X-Powered-By: Express` header. | Strict CSP: scripts from SupOps only, no plugins, no framing, form posts only to SupOps. Plus `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP and Permissions-Policy. `x-powered-by` is off. The one inline script moved to `/pwa-launch.js`, so inline scripts can be blocked. | No CSP violations on any page (Chrome logs every violation, and none appeared). Mermaid diagrams still render. No bundled library uses `eval` or `new Function`. |
| 5 | **Any website could call the API.** `Access-Control-Allow-Origin: *` on the API and socket.io, even for `Origin: https://evil.example`. | Same origin only by default. Other origins only if listed in `CORS_ORIGINS`. Dev already proxies through Vite. | No CORS header for unlisted origins. |
| 6 | **Polling storm.** An idle dashboard made **46 API requests in 30 s**: `/runs` ×8, `/dashboard` ×6, approvals ×6, health ×6, counts ×6. | Database triggers (migration 0025, table `live_versions`) bump a counter per topic on every write, from any part of the code. The server checks once a second and pushes `live:changed` over the existing socket. The browser refreshes only the affected queries. Polling becomes a 60 s safety net, and the old fast intervals return whenever the socket is down. | The same idle 30 s made **12** requests, all from the initial page load and none repeated. |
| 7 | **Duplicate name → 500.** Creating a target with a name already used in the project returned an unhandled SQLite UNIQUE error, after already storing its credential. | Checked before anything is stored, with a clear 409. All other routes: SQLite UNIQUE/foreign-key errors become 409 with a plain message, not the raw SQL error. | Unit tested. |

**Unchanged, and no problem found:**
- No console errors, page errors or failed requests on any page, before or after. The only console
  line is Playwright noting that it blocks service workers.
- Storage keys: `supops.token` and `supops.projectId` in localStorage. The token in localStorage is
  part of the parked login work.

**Seen but not fixed yet:** a Mermaid diagram in a Knowledge document showed cropped (bottom and
right cut off) in headless Chrome.
- It is not caused by the CSP: no violations were logged.
- Next step: check in a real browser during Phase 1. If it reproduces there, fix the SVG sizing in
  `components/Diagram.tsx`.

## Final pass, after Phase 6

The same capture (`capture_browser_scenario`, launch mode, events `console`, `page-errors`,
`network`, `websockets`) after every phase was in, through login, the dashboard,
Observability, an incident, SLOs, the Logs view and Settings, 10 s on each:

- **199 requests, none failed and none 4xx/5xx.** The only console lines were the capture
  tool's own "Service Worker registration blocked".
- **No polling storm came back.** No `/api/` endpoint was asked more than twice on any page.
  The dashboard made 12 API requests in its first 10 s, all part of loading it, none repeated.
  Live updates still arrive over the socket. (Phase 0 measured 30 s idle, so the windows
  differ; what matters is that nothing repeats.)
- **The main file is 313 KB (100 KB compressed), against 310 KB after Phase 0 and 900 KB
  before it.** Six phases of features went into per-page files, which load only on the page
  that uses them.
- **Phone width (390 px):** the screenshots of the new pages showed three layout faults,
  now fixed. The tab bar pushed the page wider than the screen, SLO card titles were
  squeezed, and log patterns wrapped one character per line.

## Database layout (schema only, no rows read)
- **Tables:** 33, plus the FTS5 knowledge index.
- **Indexes:** cover the hot paths (project+status, run+seq, alerts by incident, watch series by
  score).
- **No problem found.**
- **Change in this phase:** migration 0025 adds `live_versions` and its triggers. They are raw SQL,
  like `knowledge_fts`, and are not in the drizzle schema.

## How to repeat this
1. Start the demo stack on port 3098.
2. Run `capture_browser_scenario` (launch mode) with the steps above, and events
   `console`, `page-errors`, `network`, `websockets`.
3. Count `/api/` requests per step; check response headers and storage keys.

On this machine the browser needs a library wrapper (see `rea-browser-setup` in the assistant
memory).
