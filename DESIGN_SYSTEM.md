# Quantora AI — Design System Contract

This is the Phase 1 implementation contract for the requested fintech redesign. It introduces no UI code in Phase 0.

## Exact foundation tokens

| Token | Exact value | Intended use |
| --- | --- | --- |
| `--color-bg-base` | `#080C18` | App canvas and deep background. |
| `--color-surface-card` | `#1F212E` | Elevated cards, sheets, panels, and list containers. |
| `--color-accent-lime` | `#C1FF16` | Primary action, selection, positive emphasis, focus treatment. |
| `--gradient-accent-lime-soft` | `linear-gradient(135deg, #C7F091 0%, #DEF6A8 100%)` | Highlighted CTA, hero accent, selected center navigation action. |
| `--color-text-muted` | cool blue-gray | Secondary labels, metadata, inactive controls. Use one accessible final value in Phase 1 and test it against the base/surface colors. |
| `--color-danger` | red | Losses, destructive actions, validation error, urgent alert severity. Use one accessible final value in Phase 1. |

Other visual rules:

- Dark fintech presentation only by default: no white content panels, no saturated blue primary action competing with lime.
- Cards use noticeably large rounded corners; the exact radius scale is established once in the shared stylesheet and reused everywhere.
- Hero cards lead with one large value and a clearly separated percent change. Positive uses lime; negative uses danger; unavailable shows `—` and a freshness/error label, never an invented value.
- Data rows use circular instrument/avatar icons, symbol/name copy, price/change, and a small sparkline. Sparklines are descriptive; they must not be the sole carrier of gain/loss meaning.

## Responsive navigation

- Desktop/tablet wide: persistent sidebar with the seven named destinations and global search trigger. It owns navigation only, not page data state.
- Mobile: fixed pill-shaped bottom navigation. The prominent center circular action opens global Search, not an eighth page. The remaining destinations may be grouped through a More pattern only if all seven remain reachable in one interaction path.
- Global search is a reusable overlay mounted by the app shell and available on every page. It queries `/api/search`, supports keyboard navigation, and writes search/recent-viewed activity only after the user selects an instrument.

## Required reusable components

| Component | Responsibility | Data / behavior contract |
| --- | --- | --- |
| App shell | Theme tokens, responsive nav, global search overlay, network/degraded banner, toast region | Does not contain page-specific markup or fetch page data. |
| Page layout | Page title, optional ticker context, content rail, loading/empty/error states | Each of the seven pages gets a separate source file/component. |
| Hero valuation card | Main total/price, day change, freshness, small trend visual | Handles null/stale data and source labels. |
| Circular action button | Compact add/trade/alert/search actions | Accessible label, visible focus state, 44px minimum target. |
| Instrument list row | Circle icon, symbol/name, live price/change, sparkline, selected/action state | Quote patches must be ordered by WebSocket `seq`; stale state must be visible. |
| Metric/gauge card | Label, score/value, status, explanatory tooltip | Must render explicit unavailable state from `/api/gauges`. |
| Chart workbench | Candles, EMA/RSI, timeframe controls, Smart S/R annotations | Uses `/api/chart-data` and `/api/indicators`; no client-made price data. |
| Numeric entry panel | Number field plus numeric keypad, units, min/max message, submit | It works with keyboard and screen reader; keypad is an input aid, not the sole input method. |
| Position/transaction table | Portfolio positions, Greeks, transactions, pagination | Real API pagination and valuation-source/freshness labels. |
| Alert inbox row | Severity, title/body, ticker, timestamp, read state, actions | Uses cloud APIs and optimistic UI only with rollback on failure. |
| Account/security panel | Profile, preferences, session/security controls | Continues existing HttpOnly cookie + CSRF model; never reads/stores auth tokens. |

## Data and state rules

- Build a shared API client that attaches the existing CSRF header only to required same-origin mutations and handles 401/403/429/503 consistently. Do not weaken `verify_request_origin`, CSRF cookies, or HttpOnly session cookies.
- Keep request state local to the owning page/component. App-shell state is limited to session, selected ticker, navigation, global search, and network state.
- Use the real endpoints from `PROJECT_AUDIT.md`; no permanent hard-coded mock prices, positions, or notifications.
- Every data component must define loading, empty, provider-unavailable, and stale variants before visual polish.
- Preserve the distinction between live option-chain marks, Black–Scholes estimates, and intrinsic-value estimates.

