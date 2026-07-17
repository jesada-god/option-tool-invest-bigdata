# Quantora AI Frontend Redesign Plan

## Phase 0 — Audit (complete, pending review)

- [x] Read `main.py`, existing engines, `app/*.py`, frontend shell/routes, and available tests/scripts.
- [x] Inventory FastAPI HTTP and WebSocket routes with request/response contracts in `PROJECT_AUDIT.md`.
- [x] Record baseline verification results and backend/frontend findings.
- [x] Define the requested design contract and seven-page API map.
- [ ] Obtain approval of the audit documents before changing UI or backend code.

## Phase 1 — Scaffold

- [x] Preserve backend engines and auth/cloud boundaries unchanged.
- [x] Reduce `index.html` to a Vite mount document and app mount only.
- [x] Add one Tailwind-backed token stylesheet with the exact base, card, lime, and gradient values.
- [x] Establish separate physical React source files for Home, Watchlist, Analysis, Portfolio, Tools, Alerts, and Account.
- [x] Implement one app shell with desktop sidebar, mobile pill navigation, and global Search overlay placeholder.
- [x] Create HeroBalanceCard, CircleActionButton, BottomNav, Sidebar, AssetRow with Sparkline, NumericKeypad, ListItem, EmptyState, and LoadingState.
- [x] Serve the Vite build from FastAPI as static hashed assets plus SPA deep links; existing cookie/auth middleware is untouched.
- [x] Use a Node 20 Docker build stage (`npm ci`, `npm run build`) and copy `dist/` into the existing Python 3.12.7 stage.
- [x] Change Render Blueprint to Docker runtime, making the Node build deterministic and aligned with deployment.
- [x] Update frontend smoke coverage and GitHub Actions for locked install, build output, and route/component checks.

### Phase 1 deployment notes

- Render now builds the Dockerfile, so its prior Python-only `buildCommand` and `startCommand` are removed; the Python stage still starts `scripts/start-render.sh`.
- `dist/` is ignored and generated inside Docker. For local serving, run `npm ci && npm run build` before starting FastAPI.
- The Phase 1 pages are intentionally API-free placeholders. Phase 2 adds the documented same-origin API/CSRF client and WebSocket lifecycle without token storage.

## Phase 2 — Build pages

- [x] Home: portfolio, market pulse, recent-viewed endpoints, and explicit local/demo state.
- [x] Watchlist: named lists and sequence-ordered visible-row quote streams.
- [x] Analysis: quote stream, chart workbench, indicators, gauges, and research panels.
- [x] Portfolio: holdings, option positions, Greeks, and transaction history.
- [x] Tools & Simulator: calculator desk and safe result/error rendering.
- [x] Alerts: alert rules and notification inbox.
- [x] Account: identity, preferences, session, favorites, and search activity.
- [x] Global Search: query, keyboard selection, and synced activity writes.
- [x] Implement each page from `PAGE_MAP.md` against real endpoints.
- [ ] Build reusable hero cards, instrument rows/sparklines, gauge cards, numeric keypad, chart workbench, and inbox rows.
- [ ] Add loading, empty, stale, unavailable, and unauthenticated states before decorative polish.
- [ ] Replace current embedded Profile alerts/settings surfaces with dedicated Alerts and Account routes.
- [ ] Keep public/demo fallback state conspicuous and avoid mock data.

## Phase 3 — Fix backend bugs and contracts

- [x] Add regression tests, then repair only confirmed bugs: shared unauthenticated mutable state/ID collision, market failure shapes, portfolio-Greeks degradation, simulator date validation status, and documented validation gaps.
- [x] Do not rewrite or delete the listed pricing/calculation/market/auth/cloud engines.
- [x] Keep single-worker deployment constraints explicit until distributed quote/cache/alert coordination is separately approved.
- [x] Preserve or strengthen existing cookies, CSRF, origin checks, rate limits, and ownership checks.

## Phase 4 — Polish and QA

- [x] Test all seven routes on mobile and desktop, including direct/deep links and Search overlay access.
- [x] Test live quote reconnect, stale data, provider outage, capacity close, and sequence ordering.
- [ ] Test authenticated CRUD, CSRF failures, sign-out/refresh, error and keyboard/screen-reader paths.
- [x] Run the existing test suite, Python quality script, frontend script, and new targeted tests with an available Python interpreter.
- [x] Update `README.md` with the new build/run/layout instructions and deployment limitations.

## Definition of Done

- Every one of the seven pages is a real separate source file/component; no page’s markup is retained as a hidden section inside `index.html`.
- [x] All UI data/actions are wired to real APIs; no permanent mock data remains.
- Existing tests and new regression/UI-contract tests pass, along with Python and frontend quality checks.
- The app is responsive and usable on mobile and desktop, with sidebar navigation on wide screens and pill navigation on mobile.
- Cookie-based auth, CSRF verification, origin validation, and HttpOnly token handling remain at least as secure as the current implementation.
- Quote freshness, stale states, and estimated option valuation sources are visibly and correctly represented.
- `README.md` accurately documents the new frontend architecture and build/run process.
