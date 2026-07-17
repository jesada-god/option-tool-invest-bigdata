# Quantora AI — Seven-page Map and API Bindings

Global Search is an app-shell overlay, not a navigation destination. It uses `GET /api/search?q=&limit=`, then writes `POST /api/search-history` and `POST /api/recent-viewed` after a selected ticker when cloud sync is active.

| Page / target component | User outcome | Required real API bindings | Notes |
| --- | --- | --- | --- |
| 1. Home / Dashboard | See portfolio snapshot, quick actions, recent activity, market pulse | `GET /api/me`, `GET /api/portfolio/overview`, `GET /api/portfolio/stocks/summary`, `GET /api/positions`, `GET /api/industry-trends`, `GET /api/ai-recommendation?ticker=`, `GET /api/recent-viewed`, `GET /api/search-history` | No cloud account: show an explicit local/demo portfolio state and public market panels; do not invent totals. Quick actions deep-link to real pages/forms. |
| 2. Watchlist / Markets | Browse named watchlists, ticker rows, price/sparkline, live updates | `GET/POST/PATCH/DELETE /api/watchlists`, item CRUD/reorder endpoints, `GET /api/quote?ticker=`, `WS /ws/price/{ticker}`, `GET /api/chart-data?ticker=&timeframe=` for sparklines, `GET /api/categories`, `GET /api/categories/{category}`, `GET /api/industry-trends` | New UI should prefer named `/api/watchlists`; retain legacy `/api/watchlist` only for unavailable-auth compatibility display. Start/stop WebSockets with visible rows and apply only increasing `seq`. |
| 3. Analysis | Research one ticker with chart, indicators, Smart S/R, gauges, and explainable signal | `GET /api/quote`, `WS /ws/price/{ticker}`, `GET /api/stats`, `GET /api/chart-data`, `GET /api/indicators`, `GET /api/gauges`, `GET /api/ai-recommendation`, `GET /api/company`, `GET /api/news` | Ticker context can originate from Search/Watchlist. Use valid timeframe options only. Show stale/unavailable response variants and `valuation_source` language exactly. |
| 4. Portfolio | Manage stock/options positions, Greeks, and transaction history | `GET/POST/PATCH/DELETE /api/portfolios`, `GET /api/portfolio/overview`, `GET /api/portfolio/stocks`, `GET /api/portfolio/stocks/summary`, `POST /api/portfolio/stocks/trades`, `PATCH /api/portfolio/stocks/{holding_id}`, `GET /api/portfolio/transactions`, `GET/POST/PATCH/DELETE /api/positions`, `GET /api/portfolio/greeks` | All authenticated writes use CSRF. Values must remain currency-scoped; never total currencies together beyond returned `currency_totals`. Surface option mark source/staleness. |
| 5. Tools & Simulator | Run calculator desk, What-if, multi-scenario/Monte Carlo, and retain history | All eight `POST /api/tools/*`, `POST /api/simulate`, `POST /api/simulate-advanced`, `GET/POST/DELETE /api/simulation-history` | Use numeric entry panels. Client must handle the current single-simulator HTTP-200 `{error}` contract until its Phase 3 fix. Do not call calculators with mock results. |
| 6. Alerts / Notifications | Create and manage alert rules; read, mark, or delete inbox notifications | `GET/POST/PATCH/DELETE /api/alerts`, `GET /api/notifications?unread_only=&limit=`, `PATCH /api/notifications/{event_id}/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/{event_id}` | This becomes a first-class route/component, replacing its current embedding in the Profile sheet. Requires cloud auth; include auth-disabled and empty inbox states. |
| 7. Account / Settings | Update identity, workspace preferences, security/session choices, saved activity | `GET/PUT /api/me`, `GET/PUT /api/preferences`, `POST /api/auth/sign-out`, `POST /api/auth/refresh`, authentication flows, `GET/POST/DELETE /api/favorites`, `GET /api/search-analytics`, `GET /api/search-analytics/trending` | This becomes a first-class route/component. OAuth starts by navigation to the existing server endpoint; tokens stay HttpOnly. Do not duplicate Alerts here. |

## Route/source-file target for Phase 1

The exact framework may remain vanilla ES modules to limit scope, but each target must be physically separate and independently mounted:

```text
frontend/
  shell/                 # nav, global search overlay, auth-aware API client
  pages/
    home.js
    watchlist.js
    analysis.js
    portfolio.js
    tools.js
    alerts.js
    account.js
  components/            # shared cards, rows, charts, keypad, loading/error states
  styles/                # tokens, shell, component/page styles
```

This is an intended Phase 1 scaffold, not a Phase 0 code change. `index.html` will become a minimal document bootstrapping the shell rather than continuing to hold all page markup/styles.

