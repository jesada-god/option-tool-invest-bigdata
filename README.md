# Quantora AI

Quantora AI is a same-origin FastAPI application for stock, ETF, and
options analysis.  The existing chart, EMA, Smart Support & Resistance,
indicators, live quote, What-if, Monte Carlo, gauges, options, portfolio, and
search features remain in place; this version adds a production foundation for
cloud accounts, named workspaces, safer live-data delivery, and Render.

## What is ready

- Premium responsive terminal UI with a fixed six-item application navigation
- Deterministic ticker catalog and category search (including fuzzy ticker search)
- Existing technical analysis, charting, Smart S/R, options, and simulator engines
- Calculator desk: position size, expected move, probability, compound/DCA,
  intrinsic value, fair value, and allocation validation
- One WebSocket quote poll per ticker per application process, fan-out to every
  connected browser tab; reconnect, sequence, stale-data, offline, resume, and
  stale-request guards are included
- Optional Supabase Auth using HttpOnly, same-site cookies (email/password,
  password recovery, remember-me, and server-side PKCE Google sign-in)
- PostgreSQL cloud workspace for portfolios, named watchlists, favorites,
  recent searches, recently viewed symbols, notifications, and simulator history
- Optional PostgreSQL cloud sync for profiles, preferences, portfolios,
  positions, named watchlists, and ordered watchlist items
- Durable alert rules and a private in-app notification inbox.  Price and
  Smart S/R alerts evaluate from verified fresh quotes while the terminal is
  active; cooldowns, expiry, deduplication, and read state are persisted.
- Alembic migrations, security headers, CSRF/origin checks, bounded auth rate
  limiting, health/readiness endpoints, Docker, Render Blueprint, and GitHub
  Actions validation

The legacy demo still starts without cloud credentials.  In that mode its
original in-memory watchlist and position behaviour is preserved, but it is not
private or durable.  Configure both Supabase Auth and PostgreSQL before sharing
the public deployment with real users.

## Architecture

```text
Browser tabs
  |  same-origin HTTPS / WebSocket
  v
Render FastAPI web service (one Uvicorn worker)
  |-- /                  premium app shell
  |-- /api/*             analysis, workspace, tools, auth
  |-- /ws/price/{ticker} shared quote hub per ticker
  |-- Supabase Auth      identity provider
  `-- PostgreSQL         cloud-synced user workspace
```

The backend is deliberately one worker in this release.  That makes its
in-process quote hub and rate limiter coherent.  Do not increase `--workers` or
`numInstances` until quote fan-out, rate limits, and alert processing have been
moved to Redis/a dedicated worker.

## Local run

Use Python 3.12.7 (recorded in `.python-version`).

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python main.py
```

Open `http://localhost:8000`.  Useful checks:

```powershell
Invoke-RestMethod http://localhost:8000/healthz
Invoke-RestMethod http://localhost:8000/readyz
node --check tmp_fullscript.js
python -m unittest discover -s tests -p "test_*.py"
```

`/healthz` never requires external services.  `/readyz` also checks PostgreSQL
when `DATABASE_URL` is configured.

## Required production configuration

Copy `.env.example` as a reference only; never commit a real `.env` file.

| Variable | Required for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Cloud workspace | PostgreSQL runtime URL with `sslmode=require` when required by the host. |
| `DATABASE_URL_DIRECT` | Optional migrations | Direct PostgreSQL URL; useful when runtime uses a transaction pooler. |
| `SUPABASE_URL` | Accounts | Project URL, e.g. `https://project.supabase.co`. |
| `SUPABASE_ANON_KEY` | Accounts | Public anon key only. Never put a Supabase service-role key in this app. |
| `PUBLIC_APP_URL` | Production auth | Exact public HTTPS origin, e.g. `https://quantora-ai.onrender.com`. |
| `AUTH_STATE_SECRET` | Google sign-in | A unique random value of at least 32 characters. |
| `AUTH_COOKIE_SECURE=true` | Production auth | Required for HTTPS-only cookies. |
| `MARKET_DATA_PROVIDER` / `POLYGON_API_KEY` | Licensed quote source | Optional. See the market-data note below. |
| `OPERATIONS_TOKEN` | Incident diagnostics | Optional; enables protected cache/debug endpoints only when supplied. |

Set `SUPABASE_GOOGLE_ENABLED=false` until the Google provider is configured.
Google is automatically hidden if `PUBLIC_APP_URL` or `AUTH_STATE_SECRET` is
missing, rather than falling back to an unsafe browser-token flow.

### Supabase setup

1. Create a Supabase project and enable Email auth.  Configure the email
   confirmation/recovery redirect URL as your `PUBLIC_APP_URL`.
2. In Supabase Auth URL configuration, set the Site URL to that exact public
   URL.  Add the app URL and `https://YOUR_SERVICE.onrender.com/api/auth/google/callback`
   to allowed redirect URLs.  If your Supabase project uses wildcard redirect
   rules, allow the callback path with its query string as well.
3. For Google, enable the Google provider in Supabase and add the Google OAuth
   client credentials in the Supabase dashboard.  The client secret belongs in
   Supabase, not in this repository or Render environment.
4. Add the `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PUBLIC_APP_URL`, and a unique
   `AUTH_STATE_SECRET` to Render.  Restart after changing them.

### Authentication API and Google configuration

Supabase owns password hashes, email confirmation, Google identities, token
rotation, and revocation. Quantora's PostgreSQL `profiles` table uses the same
Supabase UUID and owns only application data (preferences, portfolios,
watchlists, history, and alerts); it deliberately does not duplicate a password
or refresh-token table.

Before enabling Google, create an OAuth Web client in Google Cloud Console and
register this exact redirect URI:

```text
https://YOUR_SERVICE.onrender.com/api/auth/google/callback
```

Put the Google client ID and secret in **Supabase Auth > Providers > Google**,
not in this repository or Render. Then set `SUPABASE_GOOGLE_ENABLED=true` in
Render and add the same callback URL to Supabase's allowed redirect URLs.

The application exposes these same-origin endpoints. The documented aliases
and the existing UI routes are both supported.

| Purpose | Endpoint |
| --- | --- |
| Register | `POST /api/auth/register` or `/api/auth/sign-up` |
| Sign in | `POST /api/auth/login` or `/api/auth/sign-in` |
| Current session | `GET /api/auth/me` or `/api/me` |
| Refresh HttpOnly session | `POST /api/auth/refresh` |
| Sign out | `POST /api/auth/logout` or `/api/auth/sign-out` |
| Send/resent email confirmation | `POST /api/auth/verify-email` |
| Forgot password | `POST /api/auth/forgot-password` |
| Complete recovery password change | `POST /api/auth/reset-password` or `/api/auth/update-password` |
| Start Google sign-in | `GET /api/auth/google` or `/api/auth/google/start` |

Example registration (use your own same-origin browser client in production so
the origin and CSRF protections remain active):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/auth/register `
  -ContentType 'application/json' `
  -Body '{"email":"trader@example.com","password":"a-strong-password","full_name":"Quantora Trader","remember_me":true}'
```

For a cookie-authenticated refresh, send the same-origin `X-CSRF-Token` header
that the application received with its CSRF cookie. Tokens are never returned
to or stored by browser JavaScript.

### Auth UI maintenance

The SPA authentication modal is the existing Profile sheet in `index.html`.
`openProfileSheet()` opens it from the welcome gate, header avatar, or Profile
navigation. `renderProfileAuthContent()` renders sign-in, registration,
confirmation resend, recovery, onboarding, and authenticated states. The key
element IDs are `profile-sheet`, `profile-auth-content`, `auth-email`,
`auth-password`, and `auth-submit-button`. `authFetch()` keeps the current
CSRF token in memory and opens the sign-in modal if another protected endpoint
returns `401`; it never uses `localStorage` for credentials or tokens.

## Deploy from GitHub to Render

1. Commit and push the project to a GitHub repository.

   ```powershell
   git add .
  git commit -m "Prepare Quantora AI deployment"
   git branch -M main
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
   git push -u origin main
   ```

   If `origin` already exists, use `git remote set-url origin ...` instead.

2. On Render choose **New > Blueprint**, connect the repository, and apply
   `render.yaml`.
3. On a **new Blueprint**, Render prompts for `DATABASE_URL`, `SUPABASE_URL`,
   and `SUPABASE_ANON_KEY`; the Blueprint generates `AUTH_STATE_SECRET` and
   uses Render's HTTPS URL for `PUBLIC_APP_URL`.  Do not add secrets to
   `render.yaml` or GitHub.  If this service already exists, add the three
   secret values manually in Render's Environment page: Render only prompts
   for `sync: false` variables during the initial Blueprint creation.
4. Render runs `scripts/start-render.sh`.  When `DATABASE_URL` is present, it
   applies `alembic upgrade head` before starting FastAPI.
5. The Blueprint maps `PUBLIC_APP_URL` to the initial `onrender.com` HTTPS URL.
   If you use a custom canonical domain instead, replace that value with the
   custom HTTPS origin, update the matching Supabase redirect URLs, and
   redeploy once.
6. Confirm `/healthz`, `/readyz`, an email sign-in, cloud watchlist creation,
   and a WebSocket price update before inviting users.

GitHub Actions validates Python compilation/import/tests plus the exact inline
JavaScript mirror whenever you push or open a pull request.

## Render plan and realtime note

The Blueprint uses Render Free so it can be created without selecting a paid
instance.  A Free web service can sleep when idle and a restarted process drops
WebSocket connections; the UI reconnects safely when it becomes active again,
but it cannot guarantee continuous market monitoring while no browser is
connected.  Choose a paid always-on web service before relying on live use.

`yfinance` is a best-effort polling fallback, not an exchange-licensed real-time
feed.  For a provider-backed last-trade source, set `MARKET_DATA_PROVIDER=polygon`
and a valid `POLYGON_API_KEY` whose subscription permits the instruments and
realtime use you need.  The app explicitly marks stale/unavailable data instead
of inventing a price.

For true closed-tab alerts, multiple Render instances, or high-volume traffic,
the next infrastructure phase needs a licensed streaming feed, Redis/pub-sub,
a durable job queue/worker, and a paid always-on service.  Those capabilities
cannot be safely simulated by a single free web process.

The current live evaluator intentionally covers **price** and **Smart
Support/Resistance** rules and writes **in-app** inbox events only.  IV, news,
earnings, push, and email rule types have durable schema support but require
their respective licensed data/delivery workers before they can be advertised
as live alerts.  The UI labels this boundary instead of silently pretending a
rule will run.

## Operational security

- Auth cookies are HttpOnly and same-site; browser JavaScript never stores
  Supabase access or refresh tokens.
- Unsafe authenticated requests require same-origin validation and a CSRF
  double-submit token.
- `PUBLIC_APP_URL` is mandatory for production cloud auth so a Host header
  cannot become the trusted origin.
- Auth endpoints use an in-process bounded rate limiter.  `TRUST_PROXY_HEADERS`
  must only be set to `true` behind a proxy that sanitizes forwarded headers.
- `/api/debug/yfinance`, `/api/cache/stats`, and `/api/cache` are disabled unless
  `OPERATIONS_TOKEN` is configured and supplied as `X-Operations-Token`.

## Docker

```powershell
docker build -t quantora-ai .
docker run --rm -p 8000:8000 -e PORT=8000 quantora-ai
```

To use cloud sync in Docker, pass the same production variables with `-e` or an
uncommitted env file.

## What this app does not do

It is an analysis and planning terminal, not a broker or investment adviser.
No endpoint submits live buy/sell orders.  Outputs from calculators, gauges,
simulators, and data providers can be delayed, incomplete, or wrong and must
not be treated as investment advice.
