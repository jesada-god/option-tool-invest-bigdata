# Quantora AI — Phase 0 Project Audit

Audit date: 2026-07-17. Scope: `main.py`, all listed engines, `app/*.py`, the existing frontend shell/routes, tests, and quality scripts. No application code was changed in this phase.

## Baseline and architecture

- FastAPI serves the current single-document shell at `/`; `/assets/*` serves only allow-listed JavaScript from `frontend/`.
- The existing UI has 2,771 lines in `index.html`, plus classic-script modules and six lazy route chunks (`home`, `watchlist`, `analysis`, `tools`, `portfolio`, `search`). The route modules reduce JS loading, but markup, styles, global state, inline handlers, and several overlays remain in the HTML document. It is not yet a true one-page-per-file architecture.
- Market data uses yfinance, optionally Polygon for live last trades. The quote cache and `LiveQuoteHub` are process-local; persistence is optional PostgreSQL/Supabase.
- Engine boundaries are reusable and must be retained: calculator, pricing, statistics, portfolio Greeks, gauges, Smart S/R, simulation, AI signal, market catalog, quote hub, cache, rate limit, auth, and cloud service.

## API inventory

Notation: `Q` is query string; `Body` is JSON; cloud mutations require the existing HttpOnly-cookie session and CSRF header. `ticker` values normalized by `normalize_ticker` accept `A-Z`, digits, `.`, `-`, length 1–12 unless noted. Response fields shown are the actual top-level shape; nested resource payloads are defined by the service serializers.

### Platform and operational

| Method/path | Request | Actual response / behavior |
| --- | --- | --- |
| `GET /` | — | Serves `index.html`. |
| `GET /app.webmanifest` | — | Web manifest file. |
| `GET /service-worker.js` | — | Service worker JavaScript with `Cache-Control: no-cache`. |
| `GET /assets/routes/{route_name}.js` | allow-listed name: `home`, `watchlist`, `analysis`, `tools`, `portfolio`, `search` | JavaScript route chunk; otherwise 404. |
| `GET /assets/{asset_path}` | `.js` path contained under `frontend/` | JavaScript asset; traversal/non-JS/non-file is 404. |
| `GET /healthz` | — | `{status:"ok"}`. |
| `GET /readyz` | — | `{status:"ok", persistence:"disabled"|"ready"}`; 503 if configured database is unavailable. |
| `GET /api/debug/yfinance` | `Q: ticker`; operational-access guard | Diagnostic provider fields including raw exception summaries. |
| `GET /api/cache/stats` | operational-access guard | TTL cache counters `{entries,inflight,hits,misses,coalesced}`. |
| `DELETE /api/cache` | operational-access guard | Clears process cache: `{status:"cleared"}`. |

### Auth and account

| Method/path | Request | Actual response / behavior |
| --- | --- | --- |
| `GET /api/auth/config` | — | `{auth_enabled,google_enabled,cloud_sync_enabled}`. |
| `GET /api/me` and legacy alias `GET /api/auth/me` | cookies | Session state: `{auth_enabled,authenticated,google_enabled,cloud_sync_enabled,csrf_token,user?,configuration_error?}`. `user` is `{id,email,username,avatar_url,needs_onboarding}` when available. |
| `POST /api/auth/sign-up` and alias `/api/auth/register` | Body `{email,password,full_name?,remember_me}`; same-origin | `{authenticated,message}` and possibly session cookies. |
| `POST /api/auth/sign-in` and alias `/api/auth/login` | same `AuthCredentialsModel`; same-origin | `{authenticated:true,message:"Signed in."}` plus cookies. |
| `GET /api/auth/google/start` and alias `/api/auth/google` | browser request | Starts server-side PKCE and redirects to Supabase/Google; transaction remains HttpOnly cookie. |
| `GET /api/auth/google/callback` | `Q: code?,txn?,error?` | Completes OAuth or redirects with `auth_error=google_sign_in_failed`; no token in URL. |
| `POST /api/auth/forgot-password` | Body `{email}`; same-origin | Generic `{message}` to avoid account enumeration. |
| `POST /api/auth/verify-email` | Body `{email}`; same-origin | Generic verification-resend `{message}`. |
| `POST /api/auth/refresh` | CSRF + refresh cookie | `{authenticated:true,csrf_token,user:{id,email}}`; rotates session cookies. |
| `POST /api/auth/session` | Body `{access_token,refresh_token}`; same-origin | Exchanges provider session for HttpOnly cookies: `{authenticated:true}`. |
| `POST /api/auth/sign-out` and alias `/api/auth/logout` | CSRF + cookie when auth enabled | Clears cookies: `{status:"signed_out"}`. |
| `POST /api/auth/update-password` and alias `/api/auth/reset-password` | Body `{password}`; recovery session + CSRF | `{message:"Password updated."}`. |
| `PUT /api/me` | Body `{username?,avatar_url?}`; cloud auth + CSRF | `{user: profilePayload}`. `avatar_url` is an image data URL only. |
| `GET /api/preferences` | cloud auth | `{preferences: preferencePayload}`. |
| `PUT /api/preferences` | Body `{ema_settings?,ema_master_enabled?,theme?,language?,currency?,timezone?,default_timeframe?,default_indicator?}`; cloud auth + CSRF | `{preferences: preferencePayload}`. |

### Search, market, and live quotes

| Method/path | Request | Actual response / behavior |
| --- | --- | --- |
| `GET /api/tickers` | `Q: q="", limit=1..50` | Array of catalog instrument objects; compatibility shape (not wrapped). |
| `GET /api/search` | `Q: q="", limit=1..50` | `{items:[instrument]}`. An instrument includes catalog symbol/name/category metadata. |
| `GET /api/categories` | — | `{items:[category]}`. |
| `GET /api/categories/{category}` | `Q: limit=1..50` | `{category,items:[instrument]}`. |
| `GET /api/industry-trends` | — | `{items:[{name,category,performance_pct,stock_count,sample_size,relative_volume,momentum,activity_score,as_of}],method}`; provider timeout degrades to an empty list. |
| `GET /api/quote` | `Q: ticker="NVDA"` | Live snapshot `{type:"quote",ticker,seq,sent_at,price,market_session,provider,updated_at,stale,error?}`. |
| `WS /ws/price/{ticker}` | valid ticker | Pushes the same quote snapshot every polling interval. Capacity rejection closes with code 1013; malformed ticker closes 1008. |
| `GET /api/stats` | `Q: ticker="NVDA"` | Stats object: ticker, price/close/session fields, PE, market cap, fair value/upside, volume, IV rank, call/put score, put-call ratio. Provider failures currently return `{success:true,data:[],message}` (a different shape). |
| `GET /api/chart-data` | `Q: ticker="NVDA", timeframe="1d"` | Candle array of `{time,open,high,low,close,volume,ema20,ema50,rsi}`; unavailable/timeout currently returns `{success:true,data:[],message}`. |
| `GET /api/indicators` | `Q: ticker="NVDA", timeframe="1d", psych_step?` | Smart S/R object with `support`, `resistance`, closest/strongest zones, `s1/s2/r1/r2`, source/basis timeframe, and status when unavailable. |
| `GET /api/ai-recommendation` | `Q: ticker="NVDA"` | Explainable `{ticker,signal,bullish_probability,bearish_probability,neutral_probability,confidence_score,factors_used,factors_total,reasoning,disclaimer}`. |
| `GET /api/company` | `Q: ticker="NVDA"` | Company profile: name, sector, industry, exchange, website, employees, summary, market-cap/revenue/margin/valuation fields. |
| `GET /api/news` | `Q: ticker="NVDA", limit=1..5` | `{ticker,items:[{title,publisher,link,published_at}]}`. |
| `GET /api/gauges` | `Q: ticker="NVDA", account_size>0 and <=1e9` | `{ticker,gauges,portfolio_context}`. Gauges deliberately degrade partial provider/portfolio data. |

### User activity, watchlists, portfolios, and positions

| Method/path | Request | Actual response / behavior |
| --- | --- | --- |
| `GET /api/favorites` | `Q: limit=1..500`; cloud auth | `{items:[{id,ticker,created_at}]}`. |
| `POST /api/favorites` | Body `{ticker,query?}`; cloud + CSRF | `{favorite:{id?,ticker,created_at?}}`; duplicate race is treated idempotently. |
| `DELETE /api/favorites/{ticker}` | cloud + CSRF | `{status:"deleted",ticker}`. |
| `GET /api/search-history` | `Q: limit=1..100`; cloud auth | `{items:[{id,ticker,count,query,at}]}`. |
| `POST /api/search-history` | Body `{ticker,query?}`; cloud + CSRF | `{item: activity}`. |
| `GET /api/search-analytics` | cloud auth | `{total_searches,unique_symbols,last_searched_at}`. |
| `GET /api/search-analytics/trending` | `Q: limit=1..20`; cloud auth | `{items:[catalog-enriched aggregate activity]}`. |
| `GET /api/recent-viewed` | `Q: limit=1..100`; cloud auth | `{items:[activity]}`. |
| `POST /api/recent-viewed` | Body `{ticker,query?}`; cloud + CSRF | `{item: activity}`. |
| `GET /api/simulation-history` | `Q: limit=1..100`; cloud auth | `{items:[{id,ticker,simulation_type,input_data,result_data,created_at}]}`. |
| `POST /api/simulation-history` | Body `{ticker,simulation_type,input_data,result_data}`; cloud + CSRF | `{simulation:{id,ticker,simulation_type,created_at}}`; both JSON blobs capped at 25 KB after serialization. |
| `DELETE /api/simulation-history/{history_id}` | cloud + CSRF | `{status:"deleted",id}` or 404. |
| `GET /api/watchlist` | optional cloud auth | Legacy/default watchlist plain ticker array. In no-auth mode it is shared process memory. |
| `POST /api/watchlist?ticker=...` | optional cloud auth; CSRF when cloud | Returns ticker array. Compatibility endpoint. |
| `DELETE /api/watchlist/{ticker}` | optional cloud auth; CSRF when cloud | Returns ticker array. Compatibility endpoint. |
| `GET /api/watchlists` | cloud auth | `{items:[watchlistPayload including items]}`. |
| `POST /api/watchlists` | Body `{name,is_favorite?,is_pinned?,sort_order?}`; cloud + CSRF | `{watchlist: watchlistPayload}`. |
| `GET/PATCH/DELETE /api/watchlists/{watchlist_id}` | PATCH body `{name?,is_favorite?,is_pinned?,sort_order?}`; cloud (+ CSRF for mutation) | GET `{watchlist}`, PATCH `{watchlist}`, DELETE `{status:"deleted"}`. |
| `GET /api/watchlists/{watchlist_id}/items` | cloud auth | `{items:[{id,ticker,sort_order,...}]}`. |
| `POST /api/watchlists/{watchlist_id}/items` | Body `{ticker,sort_order?}`; cloud + CSRF | `{item: watchlistItemPayload}`. |
| `DELETE /api/watchlists/{watchlist_id}/items` | `Q: ticker?` or `item_id?`; cloud + CSRF | `{status:"deleted",item}`. |
| `PUT /api/watchlists/{watchlist_id}/items/reorder` | Body `{item_ids:[int], max 500}`; cloud + CSRF | `{items:[watchlistItemPayload]}`. |
| `GET /api/portfolios` | `Q: include_archived=false`; cloud auth | `{items:[portfolioPayload]}`. |
| `POST /api/portfolios` | Body `{name,currency="USD",sort_order?}`; cloud + CSRF | `{portfolio: portfolioPayload}`. |
| `PATCH/DELETE /api/portfolios/{portfolio_id}` | PATCH body `{name,currency?}`; cloud (+ CSRF for mutation) | `{portfolio}`; DELETE archives rather than destroys. |
| `GET /api/portfolio/stocks` | `Q: portfolio_id?,include_closed=false,offset>=0,limit=1..100`; cloud auth | `{items:[stockHoldingPayload plus live valuation],offset,next_offset,has_more}`. |
| `GET /api/portfolio/stocks/summary` | `Q: portfolio_id?`; cloud auth | `{items:[portfolio payload plus holding_count,stock_value,unrealized_pnl,realized_pnl,total_pnl]}`. |
| `POST /api/portfolio/stocks/trades` | Body `{portfolio_id,ticker,side:"BUY"|"SELL",shares,price,notes?,traded_at?}`; cloud + CSRF | `{holding: stockHoldingPayload plus live valuation}`. |
| `PATCH /api/portfolio/stocks/{holding_id}` | Body `{notes?}`; cloud + CSRF | `{holding}` or 404. |
| `GET /api/portfolio/transactions` | `Q: portfolio_id?`; cloud auth | `{items:[stockTransactionPayload]}`. |
| `GET /api/portfolio/overview` | `Q: portfolio_id?`; cloud auth | `{items:[per-portfolio P&L/value],currency_totals:{currency:{realized_pnl,unrealized_pnl,total_value}}}`. |
| `GET /api/positions` | optional cloud auth | Array of option positions enriched with underlying/option marks, P&L, stale state, valuation source. |
| `POST /api/positions` | Body `{ticker,strike_price,option_type:"CALL"|"PUT",expiration,premium_paid,quantity,iv,delta,portfolio_id?}`; optional cloud auth | Enriched option position. No-auth mode is shared process memory. |
| `PATCH /api/positions/{pos_id}` | Body `{strike_price,option_type,expiration,premium_paid,quantity,iv,delta}`; optional cloud auth | Enriched option position. |
| `DELETE /api/positions/{pos_id}` | optional cloud auth | `{status:"success",position}`. |
| `GET /api/portfolio/greeks` | optional cloud auth | `portfolio_engine.compute_portfolio_greeks` result (net Greeks, positions, capital/risk fields). |

### Calculators and simulators

| Method/path | Request | Actual response / behavior |
| --- | --- | --- |
| `POST /api/tools/position-size` | Calculator-engine JSON fields | Position-size result; engine validation is translated to 422. |
| `POST /api/tools/compound` | Calculator-engine JSON fields | Compound-growth projection result. |
| `POST /api/tools/dca` | Calculator-engine JSON fields | DCA projection result. |
| `POST /api/tools/expected-move` | Calculator-engine JSON fields | Expected-move result. |
| `POST /api/tools/probability` | Calculator-engine JSON fields | Above/below probability result. |
| `POST /api/tools/intrinsic-value` | Calculator-engine JSON fields | Option intrinsic-value result. |
| `POST /api/tools/fair-value` | Calculator-engine JSON fields | DCF fair-value result. |
| `POST /api/tools/allocation` | Calculator-engine JSON fields | Normalized allocation result. |
| `POST /api/simulate` | Body `{strike_price,option_type,expiration,premium_paid,current_iv,target_price,target_date}` | `{simulated_premium,pnl_total,pnl_percent,days_remaining,break_even}`; an after-expiry target currently returns HTTP 200 `{error: ...}`. |
| `POST /api/simulate-advanced` | Body `{ticker,scenarios:[{label,strike_price,option_type,expiration,target_date,premium_paid,current_iv,quantity,r,q,iv_shock_pts,rate_shock_pts,dividend_shock_pts,n_sims,target_price_override?}]}` | `{ticker,underlying_price,results}`. Max 10 scenarios, 50k each, 100k total; invalid target date is 422. |

## Findings

### High priority before Phase 2/3

1. **The requested Python verification is blocked locally.** `python` is not recognized in this environment, so neither unit tests nor `scripts/check_python_quality.py` ran. The Node frontend check passed. This must be repaired with the project Python interpreter/virtual environment before UI work claims a green baseline.
2. **The legacy no-auth state is global and not concurrency-safe.** `watchlist` and `logged_positions` in `main.py` are process-wide mutable lists. All anonymous visitors share them; simultaneous list replacements/appends can lose updates, and random 4-digit option IDs can collide. Phase 3 should fix this only as a backend bug, without replacing the engines.
3. **The live quote architecture is explicitly single-process.** `LiveQuoteHub`, `live_prices`, alert cadence, TTL cache, and refresh coordinator are in-memory. Multiple Uvicorn workers/instances produce separate streams/caches, duplicate upstream polling, and potentially duplicate/missed alert evaluation. Keep deployment at one worker/instance until a Redis/pub-sub and distributed lock design is approved.
4. **Several public market/API result shapes are inconsistent on degradation.** `/api/stats` and `/api/chart-data` normally return an object/array but return `{success,data,message}` on unavailable/timeout. Page contracts must normalize this centrally before the redesign; a Phase 3 compatibility fix should make explicit stable unavailable shapes.
5. **`GET /api/portfolio/greeks` has no endpoint-level provider failure handling.** It directly calls `compute_portfolio_greeks(...get_base_price)`; a quote failure bubbles to the global 503 rather than a documented partial/unavailable portfolio response. Gauges handles this case more safely.

### Input validation and API contract gaps

1. Calculator routes accept raw `dict[str, Any]`. The calculator engine validates semantic fields, but unknown fields rely on Python `TypeError` and there is no generated OpenAPI request model. Document concrete calculator schemas in Phase 1 before forms are built.
2. `AlertCreateModel`/`AlertUpdateModel` bound basic field sizes, but `target_value` and `config` are intentionally validated deeper in `alert_service`. Keep UI input constrained to the supported alert-type/condition matrix; do not infer supported combinations from the top-level Pydantic model.
3. `GET /api/indicators` silently turns an unsupported timeframe into `1d`, while reporting the requested value in places. The frontend needs a fixed allowable timeframe list and visible fallback state.
4. `/api/simulate` represents a business validation failure (`target_date > expiration`) as HTTP 200 with `{error}`; the other simulator returns 422. Normalize this in the Phase 3 bug pass and make tools use error-safe rendering in the meantime.
5. Legacy `/api/watchlist` and `/api/positions` can mutate data without an authenticated user when cloud auth is disabled. This preserves demo behavior but is unsuitable for personal data and should be clearly labeled as session/demo fallback in the new interface.

### Dead code, duplicate paths, and maintenance debt

1. `PositionModel`, `get_positions_legacy`, `add_position_legacy`, and `close_position_legacy` are not used by the decorated position routes. They duplicate the active fallback behavior and should be removed only after a dedicated regression-tested cleanup.
2. `/api/auth/*` aliases and `/api/watchlist` compatibility endpoints remain legitimate compatibility surfaces, but must not be the primary new-page contract. Use the V2 cloud resources (`/api/watchlists`, `/api/portfolios`) for new screens.
3. The old page is still coupled through classic global functions, inline `onclick`, and direct DOM access. Route chunks currently load behavior, not independent page components. `FRONTEND_ROUTE_MODULES` has only six names; Alerts and Account/Settings are not separate route modules.
4. The `index.html` theme currently starts from different tokens (`#0c0d14`, `#141722`, `#00c57f`) and mostly small radii. It does not meet the requested exact dark/lime token system.

### Race conditions and resilience observations

1. Quote fan-out correctly shares one poll per ticker only inside one process and protects its structures with `asyncio.Lock`; it is safe only within that scope. Capacity is bounded, and failed sends are unsubscribed.
2. The cache uses a lock and single-flight producer correctly within a process, but a timed-out provider thread can keep the market semaphore occupied until it returns. Under upstream stalls, all bounded slots can stay occupied and requests degrade until threads finish. This is bounded, not unbounded, but should be surfaced as an operational warning.
3. Alert evaluation has process-local cadence throttling and background tasks. DB failures are intentionally swallowed after warning so quotes still flow; delivery is best-effort and no cross-instance coordination exists.
4. Auth refresh has a short in-memory two-tab coordinator, with the same cross-instance limitation. Cookie/CSRF and origin verification are otherwise present and must be preserved.

### Exception handling observations

1. The global FastAPI handlers turn validation, DB, and unexpected errors into safe JSON (good). Provider-facing code often catches broad `Exception` and returns fallback/unavailable data (intentional but reduces observability unless logs are monitored).
2. `send_line_alert` waits up to 10 seconds in synchronous request handlers and deliberately discards all request failures after a warning. It can slow position mutations; Phase 3 should decide whether to decouple it safely while retaining notification behavior.
3. `enrich_option_position` falls back from option-chain price to Black–Scholes, then intrinsic value. The response labels the valuation source, so new UI must never present estimated value as a live quote.

## Required command results

| Command | Result | Recorded output |
| --- | --- | --- |
| `python -m unittest discover -s tests -p "test_*.py"` | **Blocked** | PowerShell: `python : The term 'python' is not recognized ...` |
| `python scripts/check_python_quality.py` | **Blocked** | Same missing `python` executable/PATH error. The script would AST-check `main.py` and `app/*.py` for `eval`, `exec`, `compile`, and `print`. |
| `node scripts/check_frontend.cjs` | **Passed** | `Frontend lint passed for 48 JavaScript files.` |

The combined PowerShell command returned exit code 0 only because its final `node` command succeeded; the two Python commands did not run. Treat the baseline as **not fully verified**.
