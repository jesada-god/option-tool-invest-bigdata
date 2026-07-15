from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field, field_validator
import asyncio
import contextlib
import os
import random
import json
import requests
import math
import logging
import re
import ipaddress
import hmac
import threading
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Literal
from urllib.parse import urlencode
from zoneinfo import ZoneInfo
import yfinance as yf
import pandas as pd
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy import select

# --- JSON safety helpers ------------------------------------------------

def sanitize_json_value(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [sanitize_json_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sanitize_json_value(v) for k, v in value.items()}
    try:
        maybe_float = float(value)
        if math.isfinite(maybe_float):
            return maybe_float
    except Exception:
        pass
    return value


def sanitize_json(obj):
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_json(v) for v in obj]
    return sanitize_json_value(obj)


# --- Phase 5: institutional engines -----------------------------------
from cache import ttl_cache, get_cache_stats, clear_all_cache
import pricing_engine as pe
import stats_engine
import portfolio_engine
import gauges_engine
from calculator_engine import (
    CalculatorValidationError,
    calculate_compound_growth,
    calculate_dca_projection,
    calculate_dcf_fair_value,
    calculate_expected_move,
    calculate_option_intrinsic_value,
    calculate_position_size,
    calculate_probability_above_below,
    normalize_portfolio_allocation,
)
from market_catalog import (
    MARKET_CATALOG,
    list_categories,
    list_instruments_by_category,
    search_instruments,
)
from simulator_engine import ScenarioInput, run_multi_scenario
from smart_sr_engine import compute_smart_levels
from ai_engine import FactorInput, predict as predict_ai
from quote_hub import LiveQuoteHub, LiveQuoteHubCapacityError
from rate_limit import SlidingWindowRateLimiter
from app.auth import (
    ACCESS_COOKIE,
    CSRF_COOKIE,
    AuthProviderError,
    CurrentUser,
    begin_google_oauth,
    clear_google_oauth_transaction,
    clear_session_cookies,
    consume_google_oauth,
    create_google_callback_url,
    create_redirect_url,
    exchange_google_authorization_code,
    get_auth_settings,
    get_optional_current_user,
    get_user_from_access_token,
    password_sign_in,
    password_sign_up,
    send_password_recovery,
    set_session_cookies,
    sign_out_from_provider,
    update_password,
    verify_csrf,
    verify_request_origin,
)
from app.cloud_service import (
    CloudResourceNotFoundError,
    CloudServiceValidationError,
    DefaultResourceProtectionError,
    add_default_watchlist_ticker,
    add_watchlist_item,
    archive_portfolio,
    close_option_position,
    create_portfolio,
    create_option_position,
    create_watchlist,
    delete_watchlist,
    ensure_workspace as ensure_cloud_workspace,
    legacy_position_payload,
    list_portfolios,
    list_default_watchlist_tickers,
    list_open_option_positions,
    list_watchlist_items,
    list_watchlists,
    portfolio_payload,
    preference_payload,
    remove_watchlist_item,
    profile_payload,
    rename_portfolio,
    reorder_watchlist_items,
    remove_default_watchlist_ticker,
    update_watchlist,
    update_preferences,
    watchlist_item_payload,
    watchlist_payload,
)
from app.alert_service import (
    AlertResourceNotFoundError,
    AlertServiceValidationError,
    alert_payload,
    count_unread_notification_events,
    create_alert,
    delete_alert,
    delete_notification_event,
    evaluate_price_alerts,
    list_alerts,
    list_notification_events,
    mark_all_notifications_read,
    mark_notification_read,
    notification_event_payload,
    update_alert,
)
from app.config import PersistenceConfigurationError, load_persistence_settings
from app.db import PersistenceNotConfiguredError, database_ready, session_scope
from app.repositories import ProfileRepository
from app.models import Favorite, RecentViewed, SearchHistory, SimulationHistory

BASE_DIR = Path(__file__).resolve().parent
INDEX_FILE = BASE_DIR / "index.html"
MANIFEST_FILE = BASE_DIR / "app.webmanifest"
SERVICE_WORKER_FILE = BASE_DIR / "service-worker.js"

app = FastAPI()
logger = logging.getLogger("portfolio_terminal")


def _read_positive_env_int(key: str, default: int) -> int:
    try:
        return max(int(os.getenv(key, str(default))), 1)
    except ValueError:
        logger.warning("Invalid %s; using %s", key, default)
        return default


AUTH_RATE_LIMIT_PER_MINUTE = _read_positive_env_int("AUTH_RATE_LIMIT_PER_MINUTE", 12)
COMPUTE_RATE_LIMIT_PER_MINUTE = _read_positive_env_int("COMPUTE_RATE_LIMIT_PER_MINUTE", 6)
QUOTE_RATE_LIMIT_PER_MINUTE = _read_positive_env_int("QUOTE_RATE_LIMIT_PER_MINUTE", 120)
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() in {"1", "true", "yes", "on"}
auth_rate_limiter = SlidingWindowRateLimiter()
compute_rate_limiter = SlidingWindowRateLimiter()
quote_rate_limiter = SlidingWindowRateLimiter()
AUTH_RATE_LIMIT_PATHS = {
    "/api/auth/sign-up",
    "/api/auth/sign-in",
    "/api/auth/forgot-password",
    "/api/auth/session",
    "/api/auth/update-password",
    "/api/auth/google/start",
}
COMPUTE_RATE_LIMIT_PATHS = {"/api/simulate", "/api/simulate-advanced"}


def request_client_identity(request: Request) -> str:
    """Use a proxy-normalized client IP only when the proxy is explicitly trusted.

    A client can pre-populate a leftmost X-Forwarded-For value.  A single
    trusted reverse proxy appends the actual peer at the right, so use that
    rightmost address rather than allowing a spoofed first hop to bypass the
    auth limiter.  Deployments with a longer proxy chain should keep this
    disabled or normalize the header at their edge before forwarding it here.
    """
    if TRUST_PROXY_HEADERS:
        forwarded_values = request.headers.get("x-forwarded-for", "").split(",")
        forwarded = forwarded_values[-1].strip() if forwarded_values else ""
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            pass
    return request.client.host if request.client else "unknown"


@app.exception_handler(RequestValidationError)
async def safe_request_validation_error(request: Request, exc: RequestValidationError):
    """Return useful validation errors without reflecting submitted values.

    Pydantic includes the rejected ``input`` by default.  Besides leaking
    credentials on auth routes, reflecting it makes any HTML client that
    displays an error payload vulnerable to injected markup.
    """
    detail = [
        {key: error[key] for key in ("type", "loc", "msg") if key in error}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(OperationalError)
async def safe_database_operational_error(request: Request, exc: OperationalError):
    """Return a retryable response without leaking database topology."""
    logger.exception("Database operation failed on %s", request.url.path)
    return JSONResponse(
        status_code=503,
        content={"detail": "Cloud storage is temporarily unavailable. Please retry."},
        headers={"Retry-After": "5"},
    )


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    """Apply browser hardening without changing legacy API payloads."""
    rate_limit_response: JSONResponse | None = None
    if request.url.path in AUTH_RATE_LIMIT_PATHS:
        allowed, retry_after = auth_rate_limiter.allow(
            f"auth:{request_client_identity(request)}",
            limit=AUTH_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        if not allowed:
            rate_limit_response = JSONResponse(
                status_code=429,
                content={"detail": "Too many authentication attempts. Please try again shortly."},
                headers={"Retry-After": str(retry_after)},
            )
    elif request.url.path in COMPUTE_RATE_LIMIT_PATHS:
        allowed, retry_after = compute_rate_limiter.allow(
            f"compute:{request_client_identity(request)}",
            limit=COMPUTE_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        if not allowed:
            rate_limit_response = JSONResponse(
                status_code=429,
                content={"detail": "Too many compute requests. Please try again shortly."},
                headers={"Retry-After": str(retry_after)},
            )
    elif request.url.path == "/api/quote":
        allowed, retry_after = quote_rate_limiter.allow(
            f"quote:{request_client_identity(request)}",
            limit=QUOTE_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        if not allowed:
            rate_limit_response = JSONResponse(
                status_code=429,
                content={"detail": "Too many quote refreshes. Please try again shortly."},
                headers={"Retry-After": str(retry_after)},
            )
    response = (
        rate_limit_response
        if rate_limit_response is not None
        else await call_next(request)
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    if request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; "
        "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; "
        "frame-ancestors 'none'; form-action 'self'",
    )
    if request.url.path == "/api/quote":
        response.headers["Cache-Control"] = "no-store, max-age=0"
    private_prefixes = (
        "/api/me",
        "/api/auth/",
        "/api/preferences",
        "/api/positions",
        "/api/portfolio/",
        "/api/portfolios",
        "/api/watchlist",
        "/api/watchlists",
        "/api/alerts",
        "/api/notifications",
        "/api/favorites",
        "/api/search-history",
        "/api/recent-viewed",
        "/api/simulation-history",
        "/api/debug",
        "/api/cache",
    )
    if any(
        request.url.path == prefix or request.url.path.startswith(prefix)
        for prefix in private_prefixes
    ):
        # These routes may set HttpOnly cookies or return account state.
        response.headers["Cache-Control"] = "no-store, private, max-age=0"
        response.headers["Pragma"] = "no-cache"
        existing_vary = response.headers.get("Vary", "")
        vary_values = {value.strip() for value in existing_vary.split(",") if value.strip()}
        vary_values.add("Cookie")
        response.headers["Vary"] = ", ".join(sorted(vary_values))
    return response

# Optional secret supplied by the runtime environment; never commit a real token.
LINE_ACCESS_TOKEN = os.getenv("LINE_ACCESS_TOKEN", "")
# Operational endpoints can expose provider internals or flush shared caches.
# They stay disabled unless an operator explicitly supplies this secret in the
# runtime environment; it is never shipped to the browser.
OPERATIONS_TOKEN = os.getenv("OPERATIONS_TOKEN", "").strip()
MARKET_DATA_PROVIDER = os.getenv("MARKET_DATA_PROVIDER", "yfinance").strip().lower()
POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "").strip()
QUOTE_REGULAR_POLL_SECONDS = max(float(os.getenv("QUOTE_REGULAR_POLL_SECONDS", "3")), 0.5)
QUOTE_OFF_HOURS_POLL_SECONDS = max(float(os.getenv("QUOTE_OFF_HOURS_POLL_SECONDS", "15")), 3.0)
MARKET_DATA_TIMEOUT_SECONDS = max(float(os.getenv("MARKET_DATA_TIMEOUT_SECONDS", "12")), 1.0)
MARKET_DATA_MAX_CONCURRENCY = _read_positive_env_int("MARKET_DATA_MAX_CONCURRENCY", 8)
market_data_fetch_semaphore = asyncio.Semaphore(MARKET_DATA_MAX_CONCURRENCY)

watchlist = ["NVDA", "AAPL", "TSLA", "AMD"]
logged_positions = []
# This is a process-local cache used by the existing engines and live quote
# hub. It is intentionally not user data and must move to Redis when running
# multiple workers or Render instances.
live_prices: dict[str, dict[str, Any]] = {}
live_prices_lock = threading.RLock()
LIVE_PRICE_STALE_SECONDS = max(int(os.getenv("LIVE_PRICE_STALE_SECONDS", "120")), 10)
LIVE_PRICE_CACHE_TTL_SECONDS = max(
    int(os.getenv("LIVE_PRICE_CACHE_TTL_SECONDS", "900")), LIVE_PRICE_STALE_SECONDS
)
LIVE_PRICE_CACHE_MAX_TICKERS = max(int(os.getenv("LIVE_PRICE_CACHE_MAX_TICKERS", "1000")), 50)
LIVE_QUOTE_MAX_ACTIVE_TICKERS = max(int(os.getenv("LIVE_QUOTE_MAX_ACTIVE_TICKERS", "200")), 1)
LIVE_QUOTE_MAX_CONNECTIONS = max(int(os.getenv("LIVE_QUOTE_MAX_CONNECTIONS", "2000")), 1)
ALERT_PRICE_EVALUATION_MIN_INTERVAL_SECONDS = max(
    float(os.getenv("ALERT_PRICE_EVALUATION_MIN_INTERVAL_SECONDS", "5")), 1.0
)
ALERT_PREVIOUS_QUOTE_MAX_AGE_SECONDS = max(
    int(os.getenv("ALERT_PREVIOUS_QUOTE_MAX_AGE_SECONDS", "30")), 1
)
ALERT_EVALUATION_MAX_CONCURRENCY = _read_positive_env_int(
    "ALERT_EVALUATION_MAX_CONCURRENCY", 2
)
alert_evaluation_semaphore = asyncio.Semaphore(ALERT_EVALUATION_MAX_CONCURRENCY)
alert_evaluation_tasks: set[asyncio.Task[Any]] = set()
TICKER_PATTERN = re.compile(r"^[A-Z0-9.\-]{1,12}$")
_alert_evaluation_lock = threading.Lock()
_alert_evaluation_last_ms: dict[str, int] = {}


class PositionModel(BaseModel):
    ticker: str
    strike_price: float
    option_type: str
    expiration: str
    premium_paid: float
    quantity: int
    iv: float = 0.0 # เพิ่มรองรับ IV
    delta: float = 0.0 # เพิ่มรองรับ Delta


class ValidatedPositionModel(BaseModel):
    ticker: str
    strike_price: float = Field(gt=0)
    option_type: str
    expiration: str
    premium_paid: float = Field(gt=0)
    quantity: int = Field(gt=0, le=10_000)
    iv: float = Field(default=0.0, ge=0, le=1_000)
    delta: float = Field(default=0.0, ge=-1.5, le=1.5)
    portfolio_id: Optional[int] = Field(default=None, gt=0)

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, value: str) -> str:
        symbol = str(value or "").upper().strip()
        if not TICKER_PATTERN.fullmatch(symbol):
            raise ValueError("ticker must contain 1-12 letters, digits, dots, or hyphens")
        return symbol

    @field_validator("option_type")
    @classmethod
    def validate_option_type(cls, value: str) -> str:
        option_type = str(value).upper().strip()
        if option_type not in {"CALL", "PUT"}:
            raise ValueError("option_type must be CALL or PUT")
        return option_type

    @field_validator("expiration")
    @classmethod
    def validate_expiration(cls, value: str) -> str:
        try:
            return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
        except (TypeError, ValueError) as exc:
            raise ValueError("expiration must be YYYY-MM-DD") from exc


class AuthCredentialsModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)
    remember_me: bool = True

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        email = value.strip().lower()
        if "@" not in email or email.startswith("@") or email.endswith("@"):
            raise ValueError("email must be valid")
        return email


class PasswordResetRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        email = value.strip().lower()
        if "@" not in email or email.startswith("@") or email.endswith("@"):
            raise ValueError("email must be valid")
        return email


class OAuthSessionModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    access_token: str = Field(min_length=20, max_length=8_192)
    refresh_token: Optional[str] = Field(default=None, min_length=20, max_length=8_192)


class PasswordUpdateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=8, max_length=256)


class ProfileUpdateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=32)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        username = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
            raise ValueError("username may use only letters, numbers, dots, underscores, and hyphens")
        return username


class PreferenceUpdateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ema_settings: Optional[dict[str, Any]] = None
    ema_master_enabled: Optional[bool] = None
    theme: Optional[Literal["dark", "light", "system"]] = None
    language: Optional[str] = Field(default=None, min_length=2, max_length=12)
    currency: Optional[str] = Field(default=None, min_length=3, max_length=3)
    timezone: Optional[str] = Field(default=None, min_length=1, max_length=64)
    default_timeframe: Optional[str] = Field(default=None, min_length=1, max_length=16)
    default_indicator: Optional[str] = Field(default=None, min_length=1, max_length=48)


class PortfolioCreateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    sort_order: Optional[int] = Field(default=None, ge=0, le=2_147_483_647)


class PortfolioRenameModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)


class WatchlistCreateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    is_favorite: bool = False
    is_pinned: bool = False
    sort_order: Optional[int] = Field(default=None, ge=0, le=2_147_483_647)


class WatchlistUpdateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    is_favorite: Optional[bool] = None
    is_pinned: Optional[bool] = None
    sort_order: Optional[int] = Field(default=None, ge=0, le=2_147_483_647)


class WatchlistItemCreateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticker: str = Field(min_length=1, max_length=12)
    sort_order: Optional[int] = Field(default=None, ge=0, le=2_147_483_647)


class WatchlistReorderModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_ids: list[int] = Field(max_length=500)


class ActivityTickerModel(BaseModel):
    """Ticker activity that is safe to retain in a user's cloud workspace."""

    model_config = ConfigDict(extra="forbid")

    ticker: str = Field(min_length=1, max_length=12)
    query: Optional[str] = Field(default=None, min_length=1, max_length=120)

    @field_validator("ticker")
    @classmethod
    def validate_activity_ticker(cls, value: str) -> str:
        ticker = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,11}", ticker):
            raise ValueError("ticker must contain only valid market symbol characters")
        return ticker


class SimulationHistoryCreateModel(BaseModel):
    """A bounded, JSON-only record of a completed client simulation."""

    model_config = ConfigDict(extra="forbid")

    ticker: str = Field(min_length=1, max_length=12)
    simulation_type: str = Field(min_length=1, max_length=32)
    input_data: dict[str, Any] = Field(default_factory=dict)
    result_data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("ticker")
    @classmethod
    def validate_simulation_ticker(cls, value: str) -> str:
        ticker = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,11}", ticker):
            raise ValueError("ticker must contain only valid market symbol characters")
        return ticker

    @field_validator("simulation_type")
    @classmethod
    def validate_simulation_type(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9_-]{1,32}", normalized):
            raise ValueError("simulation_type must contain letters, numbers, underscores, or hyphens")
        return normalized


class AlertCreateModel(BaseModel):
    """Public alert-definition fields; runtime trigger state is server-owned."""

    model_config = ConfigDict(extra="forbid")

    alert_type: str = Field(min_length=1, max_length=32)
    condition: str = Field(min_length=1, max_length=32)
    name: Optional[str] = Field(default=None, max_length=120)
    ticker: Optional[str] = Field(default=None, max_length=12)
    target_value: Optional[float | str] = None
    config: dict[str, Any] = Field(default_factory=dict)
    delivery_channels: Optional[list[str]] = Field(default=None, max_length=3)
    is_enabled: bool = True
    cooldown_seconds: int = Field(default=300, ge=0, le=604_800)
    expires_at: Optional[datetime] = None


class AlertUpdateModel(BaseModel):
    """Partial alert updates; unknown/runtime fields are rejected at the edge."""

    model_config = ConfigDict(extra="forbid")

    alert_type: Optional[str] = Field(default=None, min_length=1, max_length=32)
    condition: Optional[str] = Field(default=None, min_length=1, max_length=32)
    name: Optional[str] = Field(default=None, max_length=120)
    ticker: Optional[str] = Field(default=None, max_length=12)
    target_value: Optional[float | str] = None
    config: Optional[dict[str, Any]] = None
    delivery_channels: Optional[list[str]] = Field(default=None, max_length=3)
    is_enabled: Optional[bool] = None
    cooldown_seconds: Optional[int] = Field(default=None, ge=0, le=604_800)
    expires_at: Optional[datetime] = None


def run_calculator(calculator, payload: dict[str, Any]) -> dict[str, Any]:
    """Translate deterministic calculator validation into a safe API response."""
    try:
        return sanitize_json(calculator(**payload))
    except CalculatorValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TypeError as exc:
        # Missing, misspelled, and unsupported fields should be a client error,
        # not an opaque 500 from a planning-tool endpoint.
        raise HTTPException(status_code=422, detail=f"Invalid calculator inputs: {exc}") from exc


def send_line_alert(message: str):
    if not LINE_ACCESS_TOKEN:
        return
    url = "https://notify-api.line.me/api/notify"
    headers = {"Authorization": f"Bearer {LINE_ACCESS_TOKEN}"}
    data = {"message": message}
    try:
        requests.post(url, headers=headers, data=data, timeout=10)
    except Exception as e:
        print(f"LINE Notify Error: {e}")


def get_runtime_auth_settings():
    try:
        return get_auth_settings()
    except AuthProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def persistence_is_configured() -> bool:
    try:
        return load_persistence_settings().is_configured
    except PersistenceConfigurationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def get_cloud_user_or_legacy(request: Request, response: Response, *, mutate: bool = False) -> CurrentUser | None:
    """Use PostgreSQL/Auth when configured, otherwise preserve the legacy demo APIs."""
    auth_settings = get_runtime_auth_settings()
    if not auth_settings.enabled:
        return None
    if not persistence_is_configured():
        raise HTTPException(
            status_code=503,
            detail="Cloud sync requires DATABASE_URL in addition to Supabase Auth configuration.",
        )
    user = get_optional_current_user(request, response)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in is required for cloud-synced data.")
    if mutate:
        verify_csrf(request, auth_settings)
    return user


def require_cloud_user(request: Request, response: Response, *, mutate: bool = False) -> CurrentUser:
    """Require the authenticated PostgreSQL workspace used by new V2 APIs."""
    user = get_cloud_user_or_legacy(request, response, mutate=mutate)
    if user is None:
        raise HTTPException(status_code=503, detail="Cloud sync is not configured on this deployment.")
    return user


def raise_cloud_service_error(exc: Exception) -> None:
    """Keep ownership and validation errors consistent across V2 workspace APIs."""
    if isinstance(exc, CloudResourceNotFoundError):
        raise HTTPException(status_code=404, detail="Resource not found.") from exc
    if isinstance(exc, DefaultResourceProtectionError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, CloudServiceValidationError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise exc


def raise_alert_service_error(exc: Exception) -> None:
    """Map alert ownership/definition errors without exposing other users' data."""
    if isinstance(exc, AlertResourceNotFoundError):
        raise HTTPException(status_code=404, detail="Resource not found.") from exc
    if isinstance(exc, AlertServiceValidationError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise exc


def ensure_cloud_profile(user: CurrentUser) -> dict[str, Any]:
    try:
        with session_scope() as session:
            profile, _, _ = ensure_cloud_workspace(
                session,
                profile_id=user.id,
                email=user.email,
                avatar_url=user.avatar_url,
            )
            return profile_payload(profile)
    except PersistenceNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def require_operational_access(request: Request) -> None:
    """Guard diagnostics and process-wide cache controls behind a runtime secret.

    These endpoints are deliberately unavailable by default.  They are useful
    during an incident, but should never disclose provider traces or let an
    anonymous visitor clear a shared cache on a public terminal.
    """
    if not OPERATIONS_TOKEN:
        raise HTTPException(status_code=404, detail="Not found.")
    supplied = request.headers.get("X-Operations-Token", "")
    if not hmac.compare_digest(supplied, OPERATIONS_TOKEN):
        raise HTTPException(status_code=403, detail="Operational access denied.")


# ---------------------------------------------------------------------------
# 🔮 Options Math & Black-Scholes Model
# ---------------------------------------------------------------------------
def norm_cdf(x):
    """ฟังก์ชันสะสมความน่าจะเป็นแบบปกติ (Standard Normal CDF)"""
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

def black_scholes(S, K, T, r, sigma, option_type="CALL"):
    """
    S: ราคาหุ้นเป้าหมาย (Target Price)
    K: ราคา Strike
    T: เวลาที่เหลือจนกว่าจะหมดอายุ (เป็นสัดส่วนของปี เช่น 30 วัน = 30/365)
    r: อัตราดอกเบี้ยปลอดความเสี่ยง (ใช้ 0.05 หรือ 5%)
    sigma: ค่าความผันผวนแฝง (IV - Implied Volatility)
    """
    if T <= 0:
        return max(0.0, S - K) if option_type == "CALL" else max(0.0, K - S)

    # ป้องกันกรณี IV เป็น 0
    sigma = max(sigma, 0.001)

    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    if option_type == "CALL":
        return S * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    else:
        return K * math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1)

# ---------------------------------------------------------------------------
# 🕒 Market session helper (America/New_York)
# ---------------------------------------------------------------------------
def get_market_session() -> str:
    """Returns 'PRE', 'REGULAR', 'POST' or 'CLOSED' based on real NY time."""
    now_ny = datetime.now(ZoneInfo("America/New_York"))
    if now_ny.weekday() >= 5: # เสาร์-อาทิตย์ ตลาดปิด
        return "CLOSED"
    t = now_ny.time()
    if dtime(4, 0) <= t < dtime(9, 30):
        return "PRE"
    if dtime(9, 30) <= t < dtime(16, 0):
        return "REGULAR"
    if dtime(16, 0) <= t < dtime(20, 0):
        return "POST"
    return "CLOSED"


def normalize_ticker(ticker: str) -> str:
    """Validate the symbols accepted by the public market-data endpoints."""
    symbol = str(ticker or "").upper().strip()
    if not TICKER_PATTERN.fullmatch(symbol):
        raise HTTPException(status_code=422, detail="Ticker must contain 1-12 letters, digits, dots, or hyphens.")
    return symbol


def _is_valid_price(value: Any) -> bool:
    try:
        return math.isfinite(float(value)) and float(value) > 0
    except (TypeError, ValueError):
        return False


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _store_live_price(
    ticker: str,
    price: float,
    *,
    market_session: Optional[str] = None,
    source: str = "yfinance",
    stale: bool = False,
) -> dict[str, Any]:
    """Store a real provider value with freshness metadata, never a fake fallback."""
    if not _is_valid_price(price):
        raise ValueError(f"Invalid market price received for {ticker}")
    now_ms = _now_ms()
    with live_prices_lock:
        _prune_live_price_cache(now_ms)
        snapshot = {
            "price": round(float(price), 2),
            "market_session": market_session or get_market_session(),
            "source": source,
            "updated_at": now_ms,
            "stale": bool(stale),
        }
        live_prices[ticker] = snapshot
        _prune_live_price_cache(now_ms)
        return dict(snapshot)


def _prune_live_price_cache(now_ms: Optional[int] = None) -> None:
    """Keep the process-local provider cache bounded for public ticker input."""
    with live_prices_lock:
        now_ms = _now_ms() if now_ms is None else now_ms
        cutoff = now_ms - LIVE_PRICE_CACHE_TTL_SECONDS * 1_000
        for symbol, snapshot in list(live_prices.items()):
            if int(snapshot.get("updated_at") or 0) < cutoff:
                live_prices.pop(symbol, None)
        overflow = len(live_prices) - LIVE_PRICE_CACHE_MAX_TICKERS
        if overflow > 0:
            oldest = sorted(
                (int(snapshot.get("updated_at") or 0), symbol)
                for symbol, snapshot in list(live_prices.items())
            )
            for _, symbol in oldest[:overflow]:
                live_prices.pop(symbol, None)


def _cached_live_snapshot(ticker: str, *, allow_stale: bool = False) -> Optional[dict[str, Any]]:
    with live_prices_lock:
        _prune_live_price_cache()
        snapshot = live_prices.get(ticker)
        if not snapshot or not _is_valid_price(snapshot.get("price")):
            return None
        age_ms = max(_now_ms() - int(snapshot.get("updated_at", 0) or 0), 0)
        if not allow_stale and age_ms > LIVE_PRICE_STALE_SECONDS * 1000:
            return None
        return {**snapshot, "age_ms": age_ms}


@ttl_cache(ttl_seconds=5)
def get_price_bundle(ticker: str) -> dict:
    ticker = normalize_ticker(ticker)
    session = get_market_session()
    stock = yf.Ticker(ticker)
    try:
        info = stock.info
    except Exception:
        info = {}

    reg_price = info.get('regularMarketPrice') or info.get('currentPrice')
    prev_close = info.get('previousClose') or info.get('regularMarketPreviousClose')
    pre_price = info.get('preMarketPrice')
    post_price = info.get('postMarketPrice')

    # ⭐ [แก้ไขเพิ่มเติม] ระบบดึงราคา Pre-Market / Post-Market สำรองอย่างแม่นยำกรณีค่าใน info เป็น None
    if not pre_price or not post_price:
        try:
            hist_1m = stock.history(period="2d", interval="5m", prepost=True)
            if not hist_1m.empty:
                if hist_1m.index.tz is None:
                    hist_1m = hist_1m.tz_localize("UTC").tz_convert("America/New_York")
                else:
                    hist_1m = hist_1m.tz_convert("America/New_York")

                if not pre_price:
                    pre_df = hist_1m.between_time("04:00", "09:29")
                    if not pre_df.empty:
                        pre_price = float(pre_df['Close'].iloc[-1])

                if not post_price:
                    post_df = hist_1m.between_time("16:00", "20:00")
                    if not post_df.empty:
                        post_price = float(post_df['Close'].iloc[-1])
        except Exception:
            pass

    last_close = reg_price or prev_close
    if not last_close:
        try:
            hist = stock.history(period="5d", interval="1d")
            if not hist.empty:
                last_close = float(hist['Close'].iloc[-1])
        except Exception:
            pass

    cached = _cached_live_snapshot(ticker)
    if not _is_valid_price(last_close) and cached is not None:
        last_close = cached["price"]
    if not _is_valid_price(last_close):
        raise RuntimeError(f"No valid market price is available for {ticker}")

    last_close = float(last_close)
    reg_price = float(reg_price) if _is_valid_price(reg_price) else last_close

    if session == "REGULAR":
        current_price = reg_price
    elif session == "PRE":
        current_price = pre_price or last_close
    elif session == "POST":
        current_price = post_price or reg_price
    else:
        current_price = last_close

    snapshot = _store_live_price(ticker, current_price, market_session=session)

    return {
        "current_price": round(float(current_price), 2),
        "close_price": round(float(last_close), 2),
        "prev_close": round(float(prev_close), 2) if prev_close else round(float(last_close), 2),
        "pre_price": round(float(pre_price), 2) if pre_price else None,
        "post_price": round(float(post_price), 2) if post_price else None,
        "market_session": session,
        "source": snapshot["source"],
        "quote_updated_at": snapshot["updated_at"],
        "stale": False,
    }

def get_base_price(ticker: str) -> float:
    ticker = normalize_ticker(ticker)
    cached = _cached_live_snapshot(ticker)
    if cached is not None:
        return float(cached["price"])
    try:
        bundle = get_price_bundle(ticker)
        return bundle["current_price"]
    except Exception as exc:
        # Calculation APIs fail rather than invent a $100 value or silently
        # use an unboundedly old quote when the provider is unavailable.
        raise RuntimeError(f"No usable market price is available for {ticker}") from exc

def get_live_1m_price(ticker: str):
    ticker = normalize_ticker(ticker)
    try:
        fi = yf.Ticker(ticker).fast_info
        price = fi.get("last_price") if hasattr(fi, "get") else getattr(fi, "last_price", None)
        if price:
            return float(price)
    except Exception:
        pass
    try:
        hist = yf.Ticker(ticker).history(period="1d", interval="1m")
        if not hist.empty:
            return float(hist['Close'].iloc[-1])
    except Exception:
        pass
    return None


async def run_bounded_market_call(function, *args):
    """Run one blocking provider call with a timeout and bounded live threads.

    A timed-out yfinance call cannot always be force-cancelled by Python.  The
    semaphore therefore remains held until that background thread actually
    finishes, preventing a slow upstream from spawning an unbounded number of
    workers while the quote hub serves stale status to clients.
    """
    await asyncio.wait_for(
        market_data_fetch_semaphore.acquire(), timeout=MARKET_DATA_TIMEOUT_SECONDS
    )
    task = asyncio.create_task(asyncio.to_thread(function, *args))

    def release_when_finished(completed_task: asyncio.Task) -> None:
        market_data_fetch_semaphore.release()
        # Retrieve a late exception when the caller has already returned on a
        # timeout, avoiding an unobserved-task warning in the server logs.
        with contextlib.suppress(asyncio.CancelledError, Exception):
            completed_task.exception()

    task.add_done_callback(release_when_finished)
    return await asyncio.wait_for(asyncio.shield(task), timeout=MARKET_DATA_TIMEOUT_SECONDS)


def get_polygon_last_trade(ticker: str) -> Optional[float]:
    """Return a Polygon last-trade price when a licensed API key is configured."""
    if not POLYGON_API_KEY:
        return None
    response = requests.get(
        f"https://api.polygon.io/v2/last/trade/{ticker}",
        params={"apiKey": POLYGON_API_KEY},
        timeout=MARKET_DATA_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json() or {}
    result = payload.get("results") or {}
    price = result.get("p", result.get("price"))
    return float(price) if _is_valid_price(price) else None


def _claim_price_alert_evaluation(ticker: str, now_ms: int) -> bool:
    """Throttle durable alert evaluation without retaining arbitrary ticker state."""
    with _alert_evaluation_lock:
        cutoff = now_ms - LIVE_PRICE_CACHE_TTL_SECONDS * 1_000
        for symbol, observed_at in list(_alert_evaluation_last_ms.items()):
            if observed_at < cutoff:
                _alert_evaluation_last_ms.pop(symbol, None)
        previous = _alert_evaluation_last_ms.get(ticker)
        if previous is not None and now_ms - previous < ALERT_PRICE_EVALUATION_MIN_INTERVAL_SECONDS * 1_000:
            return False
        _alert_evaluation_last_ms[ticker] = now_ms
        if len(_alert_evaluation_last_ms) > LIVE_PRICE_CACHE_MAX_TICKERS:
            oldest = sorted(_alert_evaluation_last_ms.items(), key=lambda item: item[1])
            for symbol, _ in oldest[: len(_alert_evaluation_last_ms) - LIVE_PRICE_CACHE_MAX_TICKERS]:
                _alert_evaluation_last_ms.pop(symbol, None)
        return True


def _persist_price_alert_evaluations(
    ticker: str,
    price: float,
    previous_price: float | None,
    observed_at: datetime,
) -> int:
    """Commit in-app alert events after a verified provider quote.

    This runs in a worker thread so a slow PostgreSQL write never blocks the
    quote hub's asyncio loop.  It is intentionally best-effort: failure to
    persist an alert must not turn a valid market quote into a stale quote.
    """
    try:
        if not load_persistence_settings().is_configured:
            return 0
        with session_scope() as session:
            events = evaluate_price_alerts(
                session,
                ticker,
                price,
                observed_at,
                previous_price=previous_price,
            )
            # session_scope commits on exit. Broadcast/push delivery belongs
            # to a durable worker after this commit, not to the quote request.
            return len(events)
    except Exception as exc:
        logger.warning("Price alert evaluation failed for %s: %s", ticker, exc)
        return 0


async def maybe_evaluate_price_alerts(
    ticker: str,
    price: float,
    previous_snapshot: Optional[dict[str, Any]],
) -> None:
    now_ms = _now_ms()
    if not _claim_price_alert_evaluation(ticker, now_ms):
        return
    previous_price: float | None = None
    if previous_snapshot is not None:
        age_ms = int(previous_snapshot.get("age_ms") or 0)
        candidate = previous_snapshot.get("price")
        if age_ms <= ALERT_PREVIOUS_QUOTE_MAX_AGE_SECONDS * 1_000 and _is_valid_price(candidate):
            previous_price = float(candidate)
    # Quote delivery never waits for PostgreSQL.  When the tiny detached pool
    # is busy, the next provider tick can try again while the browser still
    # receives its verified live quote immediately.
    if alert_evaluation_semaphore.locked():
        logger.warning("Price alert evaluation queue is saturated for %s", ticker)
        return
    await alert_evaluation_semaphore.acquire()
    task = asyncio.create_task(
        asyncio.to_thread(
            _persist_price_alert_evaluations,
            ticker,
            float(price),
            previous_price,
            datetime.now(timezone.utc),
        )
    )

    def release_when_finished(completed_task: asyncio.Task) -> None:
        alert_evaluation_tasks.discard(completed_task)
        alert_evaluation_semaphore.release()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            completed_task.exception()

    alert_evaluation_tasks.add(task)
    task.add_done_callback(release_when_finished)


async def fetch_live_quote(ticker: str) -> dict[str, Any]:
    """Fetch one provider quote for the shared WebSocket hub.

    Polygon can be enabled with a licensed key; yfinance remains the default
    best-effort polling fallback. When both are unavailable this function
    preserves a last known quote only with ``stale: true`` and never fabricates
    a replacement price.
    """
    ticker = normalize_ticker(ticker)
    session = get_market_session()
    previous_snapshot = _cached_live_snapshot(ticker, allow_stale=True)
    try:
        if MARKET_DATA_PROVIDER == "polygon" and POLYGON_API_KEY:
            try:
                price = await run_bounded_market_call(get_polygon_last_trade, ticker)
                if _is_valid_price(price):
                    snapshot = _store_live_price(ticker, float(price), market_session=session, source="polygon")
                    await maybe_evaluate_price_alerts(ticker, snapshot["price"], previous_snapshot)
                    return {
                        "price": snapshot["price"],
                        "market_session": session,
                        "provider": snapshot["source"],
                        "updated_at": snapshot["updated_at"],
                        "stale": False,
                    }
            except Exception as provider_error:
                logger.warning("Polygon quote fetch failed for %s: %s; falling back to yfinance", ticker, provider_error)
        if session == "REGULAR":
            price = await run_bounded_market_call(get_live_1m_price, ticker)
            if _is_valid_price(price):
                snapshot = _store_live_price(ticker, float(price), market_session=session)
                await maybe_evaluate_price_alerts(ticker, snapshot["price"], previous_snapshot)
                return {
                    "price": snapshot["price"],
                    "market_session": session,
                    "provider": snapshot["source"],
                    "updated_at": snapshot["updated_at"],
                    "stale": False,
                }

        bundle = await run_bounded_market_call(get_price_bundle, ticker)
        if _is_valid_price(bundle.get("current_price")):
            await maybe_evaluate_price_alerts(
                ticker, float(bundle["current_price"]), previous_snapshot
            )
        return {
            "price": bundle["current_price"],
            "market_session": bundle["market_session"],
            "provider": bundle.get("source", "yfinance"),
            "updated_at": bundle.get("quote_updated_at", _now_ms()),
            "stale": bool(bundle.get("stale", False)),
        }
    except Exception as exc:
        logger.warning("Market quote fetch failed for %s: %s", ticker, exc)
        stale = _cached_live_snapshot(ticker, allow_stale=True)
        if stale is not None:
            return {
                "price": stale["price"],
                "market_session": stale.get("market_session", session),
                "provider": stale.get("source", "yfinance"),
                "updated_at": stale.get("updated_at"),
                "stale": True,
                "error": "Market data is temporarily unavailable.",
            }
        return {
            "price": None,
            "market_session": session,
            "provider": "yfinance",
            "updated_at": None,
            "stale": True,
            "error": "Market data is temporarily unavailable.",
        }


# One worker per ticker inside a single Uvicorn process.  Do not increase
# Render workers/instances until this is replaced with Redis/pub-sub fan-out.
quote_hub = LiveQuoteHub(
    fetch_live_quote,
    regular_poll_seconds=QUOTE_REGULAR_POLL_SECONDS,
    off_hours_poll_seconds=QUOTE_OFF_HOURS_POLL_SECONDS,
    max_active_tickers=LIVE_QUOTE_MAX_ACTIVE_TICKERS,
    max_subscribers=LIVE_QUOTE_MAX_CONNECTIONS,
    max_snapshots=LIVE_PRICE_CACHE_MAX_TICKERS,
    snapshot_ttl_seconds=LIVE_PRICE_CACHE_TTL_SECONDS,
)

def calculate_rsi(series, period=14):
    delta = series.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    return 100 - (100 / (100 + rs))

# ---------------------------------------------------------------------------
# 🧠 Call/Put Score Optimized (Technical 60% + Fundamental 40%)
# ---------------------------------------------------------------------------
@ttl_cache(ttl_seconds=60)
def calculate_option_scores(ticker: str, info: dict):
    call_technical_score = 50.0
    put_technical_score = 50.0

    try:
        hist = yf.Ticker(ticker).history(period="6mo", interval="1d")
        if not hist.empty and len(hist) > 20:
            closes = hist['Close']
            rsi_series = calculate_rsi(closes, 14)
            last_rsi = float(rsi_series.iloc[-1]) if not pd.isna(rsi_series.iloc[-1]) else 50.0
            ema20 = closes.ewm(span=20, adjust=False).mean().iloc[-1]
            ema50 = closes.ewm(span=50, adjust=False).mean().iloc[-1] if len(closes) >= 50 else ema20
            last_close = closes.iloc[-1]

            if 50 <= last_rsi <= 70:
                call_rsi_score = 88.0
            elif last_rsi > 70:
                call_rsi_score = 75.0
            elif last_rsi < 30:
                call_rsi_score = 65.0
            else:
                call_rsi_score = last_rsi

            if 30 <= last_rsi <= 50:
                put_rsi_score = 88.0
            elif last_rsi < 30:
                put_rsi_score = 75.0
            elif last_rsi > 70:
                put_rsi_score = 65.0
            else:
                put_rsi_score = 100.0 - last_rsi

            if last_close > ema20 > ema50:
                call_trend_score, put_trend_score = 90.0, 10.0
            elif last_close > ema20 and ema20 <= ema50:
                call_trend_score, put_trend_score = 70.0, 30.0
            elif last_close < ema20 < ema50:
                call_trend_score, put_trend_score = 10.0, 90.0
            elif last_close < ema20 and ema20 >= ema50:
                call_trend_score, put_trend_score = 30.0, 70.0
            else:
                call_trend_score, put_trend_score = 50.0, 50.0

            call_technical_score = (call_rsi_score * 0.4) + (call_trend_score * 0.6)
            put_technical_score = (put_rsi_score * 0.4) + (put_trend_score * 0.6)
    except Exception:
        pass

    call_fundamental_score = 50.0
    put_fundamental_score = 50.0
    try:
        rec_mean = info.get('recommendationMean')
        target = info.get('targetMeanPrice')
        current = info.get('currentPrice') or info.get('regularMarketPrice')
        rev_growth = info.get('revenueGrowth')
        profit_margin = info.get('profitMargins')

        call_subs = []
        if rec_mean:
            call_subs.append(max(0, min(100, (5.0 - float(rec_mean)) * 25)))
        if target and current:
            upside = (float(target) - float(current)) / float(current)
            call_subs.append(max(0, min(100, 50 + upside * 150)))
        if rev_growth is not None:
            call_subs.append(max(0, min(100, 50 + float(rev_growth) * 100)))
        if profit_margin is not None:
            call_subs.append(max(0, min(100, 50 + float(profit_margin) * 100)))
        if call_subs:
            call_fundamental_score = sum(call_subs) / len(call_subs)

        put_subs = []
        if rec_mean:
            put_subs.append(max(0, min(100, (float(rec_mean) - 1.0) * 25)))
        if target and current:
            downside = (float(current) - float(target)) / float(current)
            put_subs.append(max(0, min(100, 50 + downside * 150)))
        if rev_growth is not None:
            put_subs.append(max(0, min(100, 50 - float(rev_growth) * 100)))
        if profit_margin is not None:
            put_subs.append(max(0, min(100, 50 - float(profit_margin) * 100)))
        if put_subs:
            put_fundamental_score = sum(put_subs) / len(put_subs)
    except Exception:
        pass

    call_score = int(max(0, min(100, round((call_technical_score * 0.6) + (call_fundamental_score * 0.4)))))
    put_score = int(max(0, min(100, round((put_technical_score * 0.6) + (put_fundamental_score * 0.4)))))

    return call_score, put_score

def calculate_fair_value(info: dict, current_price: float):
    methods = []
    target = info.get('targetMeanPrice')
    if target and float(target) > 0:
        methods.append((float(target), 0.5, "analyst_target"))

    eps = info.get('trailingEps')
    bvps = info.get('bookValue')
    if eps and eps > 0 and bvps and bvps > 0:
        graham = (22.5 * float(eps) * float(bvps)) ** 0.5
        methods.append((graham, 0.3, "graham_number"))

    forward_eps = info.get('forwardEps')
    if forward_eps and forward_eps > 0:
        fpe = info.get('forwardPE')
        sector_pe = float(fpe) if fpe and 5 < float(fpe) < 60 else 20.0
        methods.append((float(forward_eps) * sector_pe, 0.2, "forward_pe"))

    if methods:
        total_w = sum(w for _, w, _ in methods)
        blended = sum(v * w for v, w, _ in methods) / total_w
        fair_value = round(blended, 2)
    elif eps and eps > 0:
        fair_value = round(float(eps) * 20, 2)
    else:
        fair_value = round(current_price, 2) if current_price else None

    upside_pct = None
    if fair_value and current_price:
        upside_pct = round(((fair_value - current_price) / current_price) * 100, 2)

    return fair_value, upside_pct

@ttl_cache(ttl_seconds=120)
def calculate_iv_rank(ticker: str) -> int:
    try:
        stock = yf.Ticker(ticker)
        exps = stock.options
        if exps:
            chain = stock.option_chain(exps[0])
            calls = chain.calls
            current = get_base_price(ticker)
            if not calls.empty:
                calls = calls.copy()
                calls['diff'] = (calls['strike'] - current).abs()
                atm = calls.loc[calls['diff'].idxmin()]
                iv = atm.get('impliedVolatility', None)
                if iv is not None and not pd.isna(iv):
                    return int(round(min(100, max(0, float(iv) * 100))))
    except Exception:
        pass

    try:
        hist = yf.Ticker(ticker).history(period="1y", interval="1d")
        if hist.empty or len(hist) < 30:
            return 50
        returns = hist['Close'].pct_change().dropna()
        rolling_vol = (returns.rolling(window=20).std() * (252 ** 0.5) * 100).dropna()
        if rolling_vol.empty:
            return 50
        current_vol = rolling_vol.iloc[-1]
        rank = (rolling_vol < current_vol).sum() / len(rolling_vol) * 100
        return int(round(rank))
    except Exception:
        return 50

# ---------------------------------------------------------------------------
# 🎯 Support / Resistance System
# ---------------------------------------------------------------------------
BAR_SECONDS = {
    "1m": 60, "5m": 300, "10m": 600, "15m": 900,
    "1h": 3600, "4h": 14400, "1d": 86400, "week": 604800,
}

# ⏳ [ดึงข้อมูลย้อนหลังให้มากที่สุดเท่าที่ Yahoo Finance อนุญาต]
# Yahoo บังคับเพดานตายตัวสำหรับข้อมูลแบบ intraday (ยิ่งขอเกินเพดาน ยิ่ง error ไม่ใช่แค่โดนตัด):
#   - interval 1m      : ย้อนหลังได้สูงสุด ~7 วัน
#   - interval 5m/15m   : ย้อนหลังได้สูงสุด ~60 วัน
#   - interval 60m/1h   : ย้อนหลังได้สูงสุด ~730 วัน (~2 ปี)
#   - interval 1d/1wk   : ไม่มีเพดาน ดึงได้ "max" ยาวไปจนถึงวันที่หุ้นเข้าตลาด (5 ปี+ แน่นอนสำหรับหุ้นส่วนใหญ่)
# ใช้ "days" (คำนวณช่วง start/end เอง) แทน "period" แบบเดิม เพื่อชนเพดานของ Yahoo ให้พอดีที่สุด
# (ระบบ period แบบสำเร็จรูปของ yfinance มีให้เลือกเป็นช่วงห่างๆ เช่น 1mo/3mo เท่านั้น ทำให้ได้ข้อมูลน้อยกว่าที่ Yahoo อนุญาตจริง)
TIMEFRAME_CONFIG = {
    "1m": {"days": 6, "interval": "1m"},
    "5m": {"days": 58, "interval": "5m"},
    "10m": {"days": 58, "interval": "5m", "resample": "10min"},
    "15m": {"days": 58, "interval": "15m"},
    "1h": {"days": 728, "interval": "60m"},
    "4h": {"days": 728, "interval": "60m", "resample": "4h"},
    "1d": {"period": "max", "interval": "1d"},
    "week": {"period": "max", "interval": "1wk"},
}

@ttl_cache(ttl_seconds=45)
def get_raw_history(ticker: str, timeframe: str) -> pd.DataFrame:
    """ดึงราคาย้อนหลังดิบจาก Yahoo Finance ตาม TIMEFRAME_CONFIG (ใช้ร่วมกันทั้ง chart-data และ ATR)
    Cache สั้นๆ 45 วิ เพื่อกันไม่ให้ frontend ที่ auto-refresh กราฟทุก 15 วิ ยิงไปดึงข้อมูลย้อนหลัง
    เป็นปีๆ ซ้ำจาก Yahoo รัวๆ ตลอดเวลา (ticker/timeframe ต่างกัน = แคชแยกกันอัตโนมัติ)
    """
    cfg = TIMEFRAME_CONFIG.get(timeframe, TIMEFRAME_CONFIG["1d"])
    stock = yf.Ticker(ticker)
    try:
        if "period" in cfg:
            hist = stock.history(period=cfg["period"], interval=cfg["interval"], prepost=True)
        else:
            end = datetime.now(timezone.utc)
            start = end - timedelta(days=cfg["days"])
            hist = stock.history(start=start, end=end, interval=cfg["interval"], prepost=True)
    except Exception:
        return pd.DataFrame()

    if hist is None or hist.empty:
        return pd.DataFrame()

    if cfg.get("resample"):
        agg = {"Open": "first", "High": "max", "Low": "min", "Close": "last"}
        if "Volume" in hist.columns:
            agg["Volume"] = "sum"
        hist = hist.resample(cfg["resample"]).agg(agg).dropna(subset=["Close"])

    return hist


@ttl_cache(ttl_seconds=120)
def get_recent_daily_history(ticker: str) -> pd.DataFrame:
    """A short daily window for market-activity ranking.

    Ranking must use the prior completed close rather than a provider's
    ``prev_close`` fallback, which can equal the current quote and produce a
    misleading +0.00% card outside regular market hours.
    """
    try:
        hist = yf.Ticker(ticker).history(period="2mo", interval="1d", prepost=False)
        return hist if hist is not None and not hist.empty else pd.DataFrame()
    except Exception:
        return pd.DataFrame()

@ttl_cache(ttl_seconds=300)
def get_atr_for_timeframe(ticker: str, timeframe: str, period: int = 14):
    hist = get_raw_history(ticker, timeframe)
    if hist is None or hist.empty or len(hist) < period + 1:
        return None

    high, low, close = hist['High'], hist['Low'], hist['Close']
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr = tr.rolling(window=period).mean().iloc[-1]
    if pd.isna(atr) or atr <= 0:
        return None
    return float(atr)

def format_duration(total_seconds: float) -> str:
    minutes = total_seconds / 60
    if minutes < 1: return "< 1 นาที"
    if minutes < 60: return f"~{round(minutes)} นาที"
    hours = minutes / 60
    if hours < 24:
        h = int(hours)
        m = int(round((hours - h) * 60))
        return f"~{h} ชม {m} นาที" if m else f"~{h} ชม"
    days = hours / 24
    if days < 30:
        d = int(days)
        h = int(round((days - d) * 24))
        return f"~{d} วัน {h} ชม" if h else f"~{d} วัน"
    months = days / 30
    return f"~{round(months)} เดือน+"

def estimate_eta(distance: float, atr, bar_seconds: int):
    if not atr or atr <= 0 or distance <= 0:
        return None
    bars_needed = distance / atr
    total_seconds = bars_needed * bar_seconds
    return format_duration(total_seconds)

# ---------------------------------------------------------------------------
# 📦 API Endpoints
# ---------------------------------------------------------------------------
TICKERS_DB = [
    {"symbol": "AAPL", "name": "Apple Inc."}, {"symbol": "MSFT", "name": "Microsoft Corp."},
    {"symbol": "GOOGL", "name": "Alphabet Inc. Class A"}, {"symbol": "NVDA", "name": "NVIDIA Corp."},
    {"symbol": "TSLA", "name": "Tesla Inc."}, {"symbol": "AMD", "name": "Advanced Micro Devices"}
]

@app.get("/")
async def serve_home():
    return FileResponse(INDEX_FILE)


@app.get("/app.webmanifest", include_in_schema=False)
async def serve_web_manifest():
    """Serve the install metadata with the correct manifest content type."""
    return FileResponse(MANIFEST_FILE, media_type="application/manifest+json")


@app.get("/service-worker.js", include_in_schema=False)
async def serve_service_worker():
    """The worker caches only static shell files; user data always stays cloud-backed."""
    return FileResponse(
        SERVICE_WORKER_FILE,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/healthz", include_in_schema=False)
def health_check():
    """Fast, dependency-free readiness endpoint for Render."""
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
def readiness_check():
    """Check PostgreSQL only when cloud persistence is configured."""
    if not persistence_is_configured():
        return {"status": "ok", "persistence": "disabled"}
    try:
        database_ready()
        return {"status": "ok", "persistence": "ready"}
    except Exception as exc:
        logger.error("Readiness database check failed: %s", exc)
        raise HTTPException(status_code=503, detail="Database is not ready.") from exc


def google_callback_is_available(request: Request, settings) -> bool:
    """Return whether this request can safely begin the server-side OAuth flow.

    ``AuthSettings.google_ready`` verifies provider credentials and the signing
    secret.  The callback URL additionally depends on the public deployment
    URL, so test it before presenting Google as an available login option.
    """
    if not settings.google_ready:
        return False
    try:
        create_google_callback_url(request, settings)
    except HTTPException:
        return False
    return True


def auth_runtime_is_available(request: Request, settings) -> bool:
    """Return whether account mutations have a safe, fixed public origin."""
    if not settings.enabled:
        return False
    try:
        create_redirect_url(request, settings)
    except HTTPException:
        return False
    return True


@app.get("/api/auth/config")
def auth_config(request: Request):
    settings = get_runtime_auth_settings()
    auth_enabled = auth_runtime_is_available(request, settings)
    return {
        "auth_enabled": auth_enabled,
        "google_enabled": bool(auth_enabled and google_callback_is_available(request, settings)),
        "cloud_sync_enabled": bool(auth_enabled and persistence_is_configured()),
    }


@app.get("/api/me")
def get_me(request: Request, response: Response):
    settings = get_runtime_auth_settings()
    if not settings.enabled:
        return {
            "auth_enabled": False,
            "authenticated": False,
            "google_enabled": False,
            "cloud_sync_enabled": False,
        }
    if not auth_runtime_is_available(request, settings):
        return {
            "auth_enabled": False,
            "authenticated": False,
            "google_enabled": False,
            "cloud_sync_enabled": False,
            "configuration_error": "Set PUBLIC_APP_URL before enabling cloud authentication in production.",
        }
    google_enabled = google_callback_is_available(request, settings)
    user = get_optional_current_user(request, response)
    csrf_token = response.headers.get("X-CSRF-Token") or request.cookies.get(CSRF_COOKIE)
    if user is None:
        return {
            "auth_enabled": True,
            "authenticated": False,
            "google_enabled": google_enabled,
            "cloud_sync_enabled": persistence_is_configured(),
            "csrf_token": csrf_token,
        }
    if not persistence_is_configured():
        return {
            "auth_enabled": True,
            "authenticated": True,
            "google_enabled": google_enabled,
            "cloud_sync_enabled": False,
            "csrf_token": csrf_token,
            "user": {
                "id": str(user.id),
                "email": user.email,
                "username": user.preferred_username,
                "avatar_url": user.avatar_url,
                "needs_onboarding": False,
            },
        }
    return {
        "auth_enabled": True,
        "authenticated": True,
        "google_enabled": google_enabled,
        "cloud_sync_enabled": True,
        "csrf_token": csrf_token,
        "user": ensure_cloud_profile(user),
    }


@app.post("/api/auth/sign-up")
def sign_up(payload: AuthCredentialsModel, request: Request, response: Response):
    settings = get_runtime_auth_settings()
    settings.require_enabled()
    verify_request_origin(request, settings)
    try:
        result = password_sign_up(
            settings,
            email=payload.email,
            password=payload.password,
            redirect_to=create_redirect_url(request, settings),
        )
        session = result.get("session") if isinstance(result.get("session"), dict) else None
        if session and session.get("access_token"):
            set_session_cookies(response, session, settings, remember_me=payload.remember_me)
            return {"authenticated": True, "message": "Account created."}
        return {
            "authenticated": False,
            "message": "Check your email to confirm the account, then sign in.",
        }
    except AuthProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/auth/sign-in")
def sign_in(payload: AuthCredentialsModel, request: Request, response: Response):
    settings = get_runtime_auth_settings()
    settings.require_enabled()
    verify_request_origin(request, settings)
    try:
        session = password_sign_in(settings, email=payload.email, password=payload.password)
        set_session_cookies(response, session, settings, remember_me=payload.remember_me)
        return {"authenticated": True, "message": "Signed in."}
    except AuthProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.get("/api/auth/google/start")
def start_google_sign_in(request: Request):
    settings = get_runtime_auth_settings()
    settings.require_enabled()
    if not google_callback_is_available(request, settings):
        raise HTTPException(
            status_code=503,
            detail="Google sign-in is disabled or requires PUBLIC_APP_URL and AUTH_STATE_SECRET.",
        )
    # Validate the deployment callback before setting an OAuth transaction
    # cookie.  A production misconfiguration must not leave a stale pending
    # transaction in the browser.
    callback_url = create_google_callback_url(request, settings)
    # The response object owns the HttpOnly PKCE transaction cookie. Its
    # location is replaced after the random state/challenge are created.
    response = RedirectResponse(url="/", status_code=303)
    try:
        transaction = begin_google_oauth(response, settings)
    except AuthProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    redirect_to = f"{callback_url}?{urlencode({'txn': transaction['state']})}"
    authorize_params = {
        'provider': 'google',
        'redirect_to': redirect_to,
        'code_challenge': transaction['code_challenge'],
        'code_challenge_method': 's256',
    }
    authorize_url = f"{settings.supabase_url}/auth/v1/authorize?{urlencode(authorize_params)}"
    response.headers["location"] = authorize_url
    return response


@app.get("/api/auth/google/callback", include_in_schema=False)
def complete_google_sign_in(
    request: Request,
    code: Optional[str] = Query(default=None, min_length=8, max_length=8_192),
    txn: Optional[str] = Query(default=None, min_length=16, max_length=256),
    error: Optional[str] = Query(default=None, max_length=128),
):
    """Finish Google OAuth server-side and redirect with HttpOnly cookies only."""
    settings = get_runtime_auth_settings()
    destination = create_redirect_url(request, settings)
    response = RedirectResponse(url=destination, status_code=303)
    if error or not code or not txn:
        clear_google_oauth_transaction(response, settings)
        response.headers["location"] = f"{destination}?{urlencode({'auth_error': 'google_sign_in_failed'})}"
        return response
    try:
        verifier = consume_google_oauth(request, response, settings, state=txn)
        session = exchange_google_authorization_code(
            settings, auth_code=code, code_verifier=verifier
        )
        set_session_cookies(response, session, settings, remember_me=True)
    except AuthProviderError as exc:
        logger.info("Google OAuth callback failed: %s", exc)
        response.headers["location"] = f"{destination}?{urlencode({'auth_error': 'google_sign_in_failed'})}"
    return response


@app.post("/api/auth/forgot-password")
def forgot_password(payload: PasswordResetRequestModel, request: Request):
    settings = get_runtime_auth_settings()
    settings.require_enabled()
    verify_request_origin(request, settings)
    try:
        send_password_recovery(settings, email=payload.email, redirect_to=create_redirect_url(request, settings))
    except AuthProviderError as exc:
        # Do not expose whether an email exists. Availability errors remain
        # visible so the user can retry instead of waiting indefinitely.
        if exc.status_code >= 500:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return {"message": "If this address exists, a password reset link is on its way."}


@app.post("/api/auth/session")
def exchange_auth_session(payload: OAuthSessionModel, request: Request, response: Response):
    settings = get_runtime_auth_settings()
    settings.require_enabled()
    verify_request_origin(request, settings)
    if not payload.refresh_token:
        raise HTTPException(status_code=400, detail="The authentication callback did not include a refresh token.")
    try:
        get_user_from_access_token(payload.access_token, settings)
        set_session_cookies(
            response,
            {"access_token": payload.access_token, "refresh_token": payload.refresh_token},
            settings,
            remember_me=True,
        )
        return {"authenticated": True}
    except AuthProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/auth/sign-out")
def sign_out(request: Request, response: Response):
    settings = get_runtime_auth_settings()
    if not settings.enabled:
        return {"status": "signed_out"}
    verify_csrf(request, settings)
    access_token = request.cookies.get(ACCESS_COOKIE)
    if access_token:
        try:
            sign_out_from_provider(settings, access_token=access_token)
        except AuthProviderError as exc:
            logger.info("Supabase sign-out request failed: %s", exc)
    clear_session_cookies(response, settings)
    return {"status": "signed_out"}


@app.post("/api/auth/update-password")
def change_password(payload: PasswordUpdateModel, request: Request, response: Response):
    settings = get_runtime_auth_settings()
    settings.require_enabled()
    user = get_optional_current_user(request, response)
    access_token = getattr(request.state, "auth_access_token", request.cookies.get(ACCESS_COOKIE))
    if user is None or not access_token:
        raise HTTPException(status_code=401, detail="A valid recovery session is required.")
    verify_csrf(request, settings)
    try:
        update_password(settings, access_token=access_token, password=payload.password)
        return {"message": "Password updated."}
    except AuthProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.put("/api/me")
def update_me(payload: ProfileUpdateModel, request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response, mutate=True)
    if user is None:
        raise HTTPException(status_code=503, detail="Cloud authentication is not configured.")
    try:
        with session_scope() as session:
            ensure_cloud_workspace(
                session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
            )
            profile = ProfileRepository().complete_onboarding(
                session, profile_id=user.id, username=payload.username
            )
            return {"user": profile_payload(profile)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="That username is unavailable.") from exc
    except OperationalError as exc:
        logger.exception("Profile update database failure for %s", user.id)
        raise HTTPException(status_code=503, detail="Profile storage is temporarily unavailable.") from exc
    except Exception as exc:
        logger.exception("Unexpected profile update failure for %s", user.id)
        raise HTTPException(status_code=500, detail="Unable to update profile right now.") from exc


@app.get("/api/preferences")
def get_preferences(request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response)
    if user is None:
        raise HTTPException(status_code=503, detail="Cloud authentication is not configured.")
    with session_scope() as session:
        _, _, preference = ensure_cloud_workspace(
            session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
        )
        return {"preferences": preference_payload(preference)}


@app.put("/api/preferences")
def put_preferences(payload: PreferenceUpdateModel, request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response, mutate=True)
    if user is None:
        raise HTTPException(status_code=503, detail="Cloud authentication is not configured.")
    try:
        with session_scope() as session:
            _, _, preference = ensure_cloud_workspace(
                session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
            )
            update_preferences(
                preference,
                ema_settings=payload.ema_settings,
                ema_master_enabled=payload.ema_master_enabled,
                theme=payload.theme,
                language=payload.language,
                currency=payload.currency,
                timezone=payload.timezone,
                default_timeframe=payload.default_timeframe,
                default_indicator=payload.default_indicator,
            )
            session.flush()
            return {"preferences": preference_payload(preference)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Cloud activity — favorites, recent search/viewed, simulator history
# ---------------------------------------------------------------------------
def _activity_payload(item: Any, *, timestamp_field: str) -> dict[str, Any]:
    timestamp = getattr(item, timestamp_field, None)
    return {
        "id": int(item.id),
        "ticker": item.ticker,
        "count": int(getattr(item, "search_count", getattr(item, "view_count", 1))),
        "query": getattr(item, "query", None),
        "at": timestamp.isoformat() if timestamp else None,
    }


@app.get("/api/favorites")
def get_favorites(request: Request, response: Response, limit: int = Query(100, ge=1, le=500)):
    user = require_cloud_user(request, response)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        items = session.scalars(
            select(Favorite).where(Favorite.profile_id == user.id).order_by(Favorite.created_at.desc()).limit(limit)
        ).all()
        return {"items": [{"id": int(item.id), "ticker": item.ticker, "created_at": item.created_at.isoformat()} for item in items]}


@app.post("/api/favorites")
def post_favorite(payload: ActivityTickerModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = session.scalar(select(Favorite).where(Favorite.profile_id == user.id, Favorite.ticker == payload.ticker))
            if item is None:
                item = Favorite(profile_id=user.id, ticker=payload.ticker)
                session.add(item)
                session.flush()
            return {"favorite": {"id": int(item.id), "ticker": item.ticker, "created_at": item.created_at.isoformat()}}
    except IntegrityError:
        # A double click or two tabs can race on the per-profile unique key;
        # favorites are idempotent, so clients do not need a special retry flow.
        return {"favorite": {"ticker": payload.ticker}}


@app.delete("/api/favorites/{ticker}")
def delete_favorite(ticker: str, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    ticker = normalize_ticker(ticker)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        item = session.scalar(select(Favorite).where(Favorite.profile_id == user.id, Favorite.ticker == ticker))
        if item is not None:
            session.delete(item)
        return {"status": "deleted", "ticker": ticker}


@app.get("/api/search-history")
def get_search_history(request: Request, response: Response, limit: int = Query(20, ge=1, le=100)):
    user = require_cloud_user(request, response)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        items = session.scalars(
            select(SearchHistory).where(SearchHistory.profile_id == user.id).order_by(SearchHistory.last_searched_at.desc()).limit(limit)
        ).all()
        return {"items": [_activity_payload(item, timestamp_field="last_searched_at") for item in items]}


@app.post("/api/search-history")
def post_search_history(payload: ActivityTickerModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    query = (payload.query or payload.ticker).strip()
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        item = session.scalar(select(SearchHistory).where(SearchHistory.profile_id == user.id, SearchHistory.ticker == payload.ticker))
        if item is None:
            item = SearchHistory(profile_id=user.id, ticker=payload.ticker, query=query)
            session.add(item)
        else:
            item.query = query
            item.search_count += 1
            item.last_searched_at = datetime.now(timezone.utc)
        session.flush()
        return {"item": _activity_payload(item, timestamp_field="last_searched_at")}


@app.get("/api/recent-viewed")
def get_recent_viewed(request: Request, response: Response, limit: int = Query(20, ge=1, le=100)):
    user = require_cloud_user(request, response)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        items = session.scalars(
            select(RecentViewed).where(RecentViewed.profile_id == user.id).order_by(RecentViewed.last_viewed_at.desc()).limit(limit)
        ).all()
        return {"items": [_activity_payload(item, timestamp_field="last_viewed_at") for item in items]}


@app.post("/api/recent-viewed")
def post_recent_viewed(payload: ActivityTickerModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        item = session.scalar(select(RecentViewed).where(RecentViewed.profile_id == user.id, RecentViewed.ticker == payload.ticker))
        if item is None:
            item = RecentViewed(profile_id=user.id, ticker=payload.ticker)
            session.add(item)
        else:
            item.view_count += 1
            item.last_viewed_at = datetime.now(timezone.utc)
        session.flush()
        return {"item": _activity_payload(item, timestamp_field="last_viewed_at")}


@app.get("/api/simulation-history")
def get_simulation_history(request: Request, response: Response, limit: int = Query(20, ge=1, le=100)):
    user = require_cloud_user(request, response)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        items = session.scalars(
            select(SimulationHistory).where(SimulationHistory.profile_id == user.id).order_by(SimulationHistory.created_at.desc()).limit(limit)
        ).all()
        return {"items": [{"id": int(item.id), "ticker": item.ticker, "simulation_type": item.simulation_type, "input_data": item.input_json, "result_data": item.result_json, "created_at": item.created_at.isoformat()} for item in items]}


@app.post("/api/simulation-history")
def post_simulation_history(payload: SimulationHistoryCreateModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    input_data = sanitize_json(payload.input_data)
    result_data = sanitize_json(payload.result_data)
    if len(json.dumps(input_data)) > 25_000 or len(json.dumps(result_data)) > 25_000:
        raise HTTPException(status_code=422, detail="Simulation history payload is too large.")
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        item = SimulationHistory(profile_id=user.id, ticker=payload.ticker, simulation_type=payload.simulation_type, input_json=input_data, result_json=result_data)
        session.add(item)
        session.flush()
        return {"simulation": {"id": int(item.id), "ticker": item.ticker, "simulation_type": item.simulation_type, "created_at": item.created_at.isoformat()}}


@app.delete("/api/simulation-history/{history_id}")
def delete_simulation_history(history_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        item = session.scalar(select(SimulationHistory).where(SimulationHistory.profile_id == user.id, SimulationHistory.id == history_id))
        if item is None:
            raise HTTPException(status_code=404, detail="Simulation history item was not found.")
        session.delete(item)
        return {"status": "deleted", "id": history_id}


@app.on_event("shutdown")
async def close_live_quote_hub() -> None:
    await quote_hub.close()
    tasks = list(alert_evaluation_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


@app.get("/api/quote")
async def get_quote(ticker: str = "NVDA"):
    """Small snapshot endpoint used when a browser tab resumes or reconnects."""
    ticker = normalize_ticker(ticker)
    snapshot = await quote_hub.latest(ticker)
    snapshot_age_ms = _now_ms() - int((snapshot or {}).get("updated_at") or 0)
    if snapshot is None or snapshot.get("stale") or snapshot_age_ms > 5_000:
        snapshot = await fetch_live_quote(ticker)
        snapshot = {"type": "quote", "ticker": ticker, "seq": None, "sent_at": _now_ms(), **snapshot}
    return sanitize_json(snapshot)

@app.get("/api/tickers")
def search_tickers(q: str = "", limit: int = Query(12, ge=1, le=50)):
    """Compatibility endpoint for the existing autocomplete UI.

    The old six-symbol array is replaced with a deterministic local catalog,
    so search remains fast and works even while a market-data provider is
    unavailable.  Prices are intentionally not guessed by this endpoint.
    """
    if not q.strip():
        return [instrument.as_dict() for instrument in MARKET_CATALOG[:limit]]
    return [instrument.as_dict() for instrument in search_instruments(q, limit=limit)]


@app.get("/api/search")
def search_instrument_catalog(q: str = "", limit: int = Query(12, ge=1, le=50)):
    """Full catalog response for the Search screen and future mobile clients."""
    return {"items": [instrument.as_dict() for instrument in search_instruments(q, limit=limit)]}


@app.get("/api/categories")
def get_market_categories():
    return {"items": list(list_categories())}


@app.get("/api/categories/{category}")
def get_category_instruments(category: str, limit: int = Query(50, ge=1, le=50)):
    return {
        "category": category,
        "items": [
            instrument.as_dict()
            for instrument in list_instruments_by_category(category, limit=limit)
        ],
    }


# Category activity is derived from multiple liquid catalog constituents. The
# score combines absolute daily move, relative volume, and directional breadth;
# it is a transparent attention proxy, not an assertion of total market flow.
TRENDING_INDUSTRY_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("AI", "AI"),
    ("Semiconductor", "Semiconductor"),
    ("Technology", "Technology"),
    ("Healthcare", "Healthcare"),
    ("Banking", "Bank"),
    ("Energy", "Energy"),
    ("Crypto", "Crypto"),
    ("Defense", "Defense"),
)


@ttl_cache(ttl_seconds=120)
def build_industry_trends() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for display_name, category in TRENDING_INDUSTRY_CATEGORIES:
        instruments = list_instruments_by_category(category, limit=4)
        changes: list[float] = []
        volume_ratios: list[float] = []
        latest_dates: list[str] = []
        for instrument in instruments:
            history = get_recent_daily_history(instrument.symbol)
            if history is None or history.empty or "Close" not in history.columns:
                continue
            closes = history["Close"].dropna()
            if len(closes) < 2 or float(closes.iloc[-2]) <= 0:
                continue
            changes.append(float((closes.iloc[-1] / closes.iloc[-2] - 1) * 100))
            latest_dates.append(str(closes.index[-1].date()))
            if "Volume" in history.columns:
                volumes = history["Volume"].dropna()
                baseline = volumes.iloc[-21:-1]
                if len(baseline) >= 5 and float(baseline.mean()) > 0:
                    volume_ratios.append(float(volumes.iloc[-1] / baseline.mean()))

        performance = float(sum(changes) / len(changes)) if changes else None
        bullish_count = sum(change > 0 for change in changes)
        breadth = bullish_count / len(changes) if changes else 0.5
        relative_volume = float(sum(volume_ratios) / len(volume_ratios)) if volume_ratios else 1.0
        activity_score = (
            abs(performance or 0.0) * 20.0
            + min(max(relative_volume, 0.0), 5.0) * 10.0
            + breadth * 10.0
        ) if changes else -1.0
        momentum = "Bullish" if performance is not None and performance > 0.05 else "Bearish" if performance is not None and performance < -0.05 else "Neutral"
        items.append({
            "name": display_name,
            "category": category,
            "performance_pct": round(performance, 2) if performance is not None else None,
            "stock_count": len(list_instruments_by_category(category)),
            "sample_size": len(changes),
            "relative_volume": round(relative_volume, 2) if changes else None,
            "momentum": momentum,
            "activity_score": round(activity_score, 2) if changes else None,
            "as_of": max(latest_dates) if latest_dates else None,
        })
    return sorted(items, key=lambda item: (item["activity_score"] is not None, item["activity_score"] or -1.0), reverse=True)


@app.get("/api/industry-trends")
def get_industry_trends():
    return {"items": build_industry_trends(), "method": "daily move + relative volume + breadth"}


# ---------------------------------------------------------------------------
# Planning tools — deterministic, input-led calculators (no orders, no storage)
# ---------------------------------------------------------------------------
@app.post("/api/tools/position-size")
def tool_position_size(payload: dict[str, Any]):
    return run_calculator(calculate_position_size, payload)


@app.post("/api/tools/compound")
def tool_compound(payload: dict[str, Any]):
    return run_calculator(calculate_compound_growth, payload)


@app.post("/api/tools/dca")
def tool_dca(payload: dict[str, Any]):
    return run_calculator(calculate_dca_projection, payload)


@app.post("/api/tools/expected-move")
def tool_expected_move(payload: dict[str, Any]):
    return run_calculator(calculate_expected_move, payload)


@app.post("/api/tools/probability")
def tool_probability(payload: dict[str, Any]):
    return run_calculator(calculate_probability_above_below, payload)


@app.post("/api/tools/intrinsic-value")
def tool_intrinsic_value(payload: dict[str, Any]):
    return run_calculator(calculate_option_intrinsic_value, payload)


@app.post("/api/tools/fair-value")
def tool_fair_value(payload: dict[str, Any]):
    return run_calculator(calculate_dcf_fair_value, payload)


@app.post("/api/tools/allocation")
def tool_allocation(payload: dict[str, Any]):
    return run_calculator(normalize_portfolio_allocation, payload)

@app.get("/api/watchlist")
def get_watchlist(request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response)
    if user is None:
        return list(watchlist)
    with session_scope() as session:
        ensure_cloud_workspace(
            session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
        )
        return list_default_watchlist_tickers(session, user.id)

@app.post("/api/watchlist")
def add_to_watchlist(request: Request, response: Response, ticker: str = Query(...)):
    ticker = normalize_ticker(ticker)
    user = get_cloud_user_or_legacy(request, response, mutate=True)
    if user is None:
        if ticker not in watchlist:
            watchlist.append(ticker)
        return list(watchlist)
    with session_scope() as session:
        ensure_cloud_workspace(
            session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
        )
        return add_default_watchlist_ticker(session, user.id, ticker)

@app.delete("/api/watchlist/{ticker}")
def remove_from_watchlist(ticker: str, request: Request, response: Response):
    global watchlist
    ticker = normalize_ticker(ticker)
    user = get_cloud_user_or_legacy(request, response, mutate=True)
    if user is None:
        watchlist = [t for t in watchlist if t != ticker]
        return list(watchlist)
    with session_scope() as session:
        ensure_cloud_workspace(
            session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
        )
        return remove_default_watchlist_ticker(session, user.id, ticker)


# ---------------------------------------------------------------------------
# Cloud workspace APIs — multiple portfolios and named watchlists
# ---------------------------------------------------------------------------
@app.get("/api/portfolios")
def get_portfolios(
    request: Request,
    response: Response,
    include_archived: bool = False,
):
    user = require_cloud_user(request, response)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        items = list_portfolios(session, profile_id=user.id, include_archived=include_archived)
        return {"items": [portfolio_payload(item) for item in items]}


@app.post("/api/portfolios")
def post_portfolio(payload: PortfolioCreateModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = create_portfolio(
                session,
                profile_id=user.id,
                name=payload.name,
                currency=payload.currency,
                sort_order=payload.sort_order,
            )
            return {"portfolio": portfolio_payload(item)}
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A portfolio with this name already exists.") from exc
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.patch("/api/portfolios/{portfolio_id}")
def patch_portfolio(
    portfolio_id: int,
    payload: PortfolioRenameModel,
    request: Request,
    response: Response,
):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = rename_portfolio(
                session, profile_id=user.id, portfolio_id=portfolio_id, name=payload.name
            )
            return {"portfolio": portfolio_payload(item)}
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A portfolio with this name already exists.") from exc
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.delete("/api/portfolios/{portfolio_id}")
def delete_portfolio(portfolio_id: int, request: Request, response: Response):
    """Archive a non-default portfolio; historical positions are retained."""
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = archive_portfolio(session, profile_id=user.id, portfolio_id=portfolio_id)
            return {"portfolio": portfolio_payload(item)}
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.get("/api/watchlists")
def get_watchlists(request: Request, response: Response):
    user = require_cloud_user(request, response)
    with session_scope() as session:
        ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
        return {"items": [watchlist_payload(item, include_items=True) for item in list_watchlists(session, profile_id=user.id)]}


@app.post("/api/watchlists")
def post_watchlist(payload: WatchlistCreateModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = create_watchlist(
                session,
                profile_id=user.id,
                name=payload.name,
                is_favorite=payload.is_favorite,
                is_pinned=payload.is_pinned,
                sort_order=payload.sort_order,
            )
            return {"watchlist": watchlist_payload(item, include_items=True)}
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A watchlist with this name already exists.") from exc
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.get("/api/watchlists/{watchlist_id}")
def get_named_watchlist(watchlist_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            watchlists = [item for item in list_watchlists(session, profile_id=user.id) if item.id == watchlist_id]
            if not watchlists:
                raise CloudResourceNotFoundError("watchlist not found")
            return {"watchlist": watchlist_payload(watchlists[0], include_items=True)}
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.patch("/api/watchlists/{watchlist_id}")
def patch_watchlist(
    watchlist_id: int,
    payload: WatchlistUpdateModel,
    request: Request,
    response: Response,
):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = update_watchlist(
                session,
                profile_id=user.id,
                watchlist_id=watchlist_id,
                name=payload.name,
                is_favorite=payload.is_favorite,
                is_pinned=payload.is_pinned,
                sort_order=payload.sort_order,
            )
            return {"watchlist": watchlist_payload(item, include_items=True)}
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A watchlist with this name already exists.") from exc
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.delete("/api/watchlists/{watchlist_id}")
def delete_named_watchlist(watchlist_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            delete_watchlist(session, profile_id=user.id, watchlist_id=watchlist_id)
            return {"status": "deleted"}
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.get("/api/watchlists/{watchlist_id}/items")
def get_named_watchlist_items(watchlist_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            items = list_watchlist_items(session, profile_id=user.id, watchlist_id=watchlist_id)
            return {"items": [watchlist_item_payload(item) for item in items]}
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.post("/api/watchlists/{watchlist_id}/items")
def post_named_watchlist_item(
    watchlist_id: int,
    payload: WatchlistItemCreateModel,
    request: Request,
    response: Response,
):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = add_watchlist_item(
                session,
                profile_id=user.id,
                watchlist_id=watchlist_id,
                ticker=payload.ticker,
                sort_order=payload.sort_order,
            )
            return {"item": watchlist_item_payload(item)}
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Ticker already exists in this watchlist.") from exc
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.delete("/api/watchlists/{watchlist_id}/items")
def delete_named_watchlist_item(
    watchlist_id: int,
    request: Request,
    response: Response,
    ticker: Optional[str] = None,
    item_id: Optional[int] = None,
):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            item = remove_watchlist_item(
                session,
                profile_id=user.id,
                watchlist_id=watchlist_id,
                ticker=ticker,
                item_id=item_id,
            )
            return {"status": "deleted", "item": watchlist_item_payload(item)}
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


@app.put("/api/watchlists/{watchlist_id}/items/reorder")
def put_named_watchlist_order(
    watchlist_id: int,
    payload: WatchlistReorderModel,
    request: Request,
    response: Response,
):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            items = reorder_watchlist_items(
                session,
                profile_id=user.id,
                watchlist_id=watchlist_id,
                item_ids=payload.item_ids,
            )
            return {"items": [watchlist_item_payload(item) for item in items]}
    except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
        raise_cloud_service_error(exc)


# ---------------------------------------------------------------------------
# Cloud alerts and notification inbox
# ---------------------------------------------------------------------------
@app.get("/api/alerts")
def get_alerts(
    request: Request,
    response: Response,
    include_disabled: bool = True,
):
    user = require_cloud_user(request, response)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            items = list_alerts(session, profile_id=user.id, include_disabled=include_disabled)
            return {"items": [alert_payload(item) for item in items]}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.post("/api/alerts")
def post_alert(payload: AlertCreateModel, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            alert = create_alert(
                session,
                profile_id=user.id,
                definition=payload.model_dump(mode="python"),
            )
            return {"alert": alert_payload(alert)}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.patch("/api/alerts/{alert_id}")
def patch_alert(
    alert_id: int,
    payload: AlertUpdateModel,
    request: Request,
    response: Response,
):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            alert = update_alert(
                session,
                profile_id=user.id,
                alert_id=alert_id,
                changes=payload.model_dump(mode="python", exclude_unset=True),
            )
            return {"alert": alert_payload(alert)}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.delete("/api/alerts/{alert_id}")
def delete_named_alert(alert_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            delete_alert(session, profile_id=user.id, alert_id=alert_id)
            return {"status": "deleted"}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.get("/api/notifications")
def get_notifications(
    request: Request,
    response: Response,
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=200),
):
    user = require_cloud_user(request, response)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            items = list_notification_events(
                session, profile_id=user.id, unread_only=unread_only, limit=limit
            )
            payloads = [notification_event_payload(item) for item in items]
            return {
                "items": payloads,
                "unread_count": count_unread_notification_events(session, profile_id=user.id),
            }
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.patch("/api/notifications/{event_id}/read")
def patch_notification_read(event_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            event = mark_notification_read(session, profile_id=user.id, event_id=event_id)
            return {"notification": notification_event_payload(event)}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.post("/api/notifications/read-all")
def post_notifications_read_all(request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            count = mark_all_notifications_read(session, profile_id=user.id)
            return {"marked_read": count}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)


@app.delete("/api/notifications/{event_id}")
def delete_notification(event_id: int, request: Request, response: Response):
    user = require_cloud_user(request, response, mutate=True)
    try:
        with session_scope() as session:
            ensure_cloud_workspace(session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url)
            delete_notification_event(session, profile_id=user.id, event_id=event_id)
            return {"status": "deleted"}
    except (AlertServiceValidationError, AlertResourceNotFoundError) as exc:
        raise_alert_service_error(exc)

@app.get("/api/stats")
def get_stats(ticker: str = "NVDA"):
    ticker = normalize_ticker(ticker)
    try:
        stock = yf.Ticker(ticker)
        try:
            info = stock.info
        except Exception:
            info = {}

        bundle = get_price_bundle(ticker)
        call_score, put_score = calculate_option_scores(ticker, info)
        iv_rank = calculate_iv_rank(ticker)

        mcap = info.get('marketCap', 0)
        vol = info.get('volume', 0)
        fair_value, fair_value_upside_pct = calculate_fair_value(info, bundle["current_price"])

        result = {
            "ticker": ticker,
            "current_price": bundle["current_price"],
            "close_price": bundle["close_price"],
            "prev_close": bundle["prev_close"],
            "pre_price": bundle["pre_price"],
            "post_price": bundle["post_price"],
            "market_session": bundle["market_session"],
            "pe_ratio": round(info.get('trailingPE', 0), 2) if info.get('trailingPE') else "-",
            "market_cap": f"{mcap / 1e12:.2f}T" if mcap else "-",
            "fair_value": fair_value,
            "fair_value_upside_pct": fair_value_upside_pct,
            "volume": f"{vol / 1e6:.2f}M" if vol else "-",
            "iv_rank": iv_rank,
            "call_score": call_score,
            "put_score": put_score,
            "put_call_ratio": round(put_score / max(call_score, 1), 2)
        }
        return sanitize_json(result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Stats endpoint failed for %s", ticker)
        raise HTTPException(status_code=503, detail="Market statistics are temporarily unavailable.") from exc


@app.get("/api/indicators")
def get_indicators(ticker: str = "NVDA", timeframe: str = "1d", psych_step: Optional[float] = None):
    """🎯 Smart Support/Resistance — วิเคราะห์จากหลายปัจจัยร่วมกัน (Wick Footprint,
    Base Accumulation, Psychological Levels, Volume Profile) แล้วให้คะแนน Strength 0-100
    ต่อโซน แทนที่ระบบ Pivot Point เดิมทั้งหมด
    psych_step: ปรับระยะห่างของเลขกลมเองได้ (เช่น 100, 500, 1000, 10000) ถ้าไม่ระบุจะเลือกอัตโนมัติตามสเกลราคา
    """
    ticker = normalize_ticker(ticker)
    requested_timeframe = timeframe if timeframe in TIMEFRAME_CONFIG else "1d"
    is_week = requested_timeframe == "week"
    basis = "week" if is_week else requested_timeframe

    hist = get_raw_history(ticker, requested_timeframe)
    if hist is None or hist.empty:
        hist = get_raw_history(ticker, "1d")
        basis = "1d"
    if hist is None or hist.empty or "Close" not in hist.columns:
        raise HTTPException(status_code=503, detail="Historical market data is temporarily unavailable for this ticker.")

    closes = hist["Close"].dropna()
    if closes.empty or not _is_valid_price(closes.iloc[-1]):
        raise HTTPException(status_code=503, detail="A usable market price is temporarily unavailable for this ticker.")
    try:
        current_price = get_base_price(ticker)
    except Exception as exc:
        # Smart S/R remains useful when the live quote endpoint is briefly
        # unavailable. The latest historical close is a real provider value,
        # not an invented fallback price.
        current_price = float(closes.iloc[-1])
        logger.info("Using latest historical close for indicators %s: %s", ticker, exc)

    try:
        atr = get_atr_for_timeframe(ticker, requested_timeframe)
        supports_raw, resistances_raw = compute_smart_levels(
            hist, current_price, atr, psych_step=psych_step
        )
    except Exception as exc:
        # A malformed provider row must not turn the whole chart into a 500.
        # Return an empty, valid S/R payload so EMA/chart controls remain
        # available and the next cached refresh can retry the analysis.
        logger.exception("Smart S/R computation failed for %s", ticker)
        supports_raw, resistances_raw = [], []
    bar_seconds = BAR_SECONDS.get(requested_timeframe, 86400)

    def build_level(zone: dict, kind: str, idx: int):
        price = zone["price"]
        distance = abs(price - current_price)
        distance_pct = round((distance / current_price) * 100, 2) if current_price else 0
        return {
            "label": f"{kind}{idx}",
            "level": price,
            "distance_pct": distance_pct,
            "eta": estimate_eta(distance, atr, bar_seconds),
            "strength": zone["strength"],
            "confidence": zone["confidence"],
            "reasons": zone["reasons"],
            "zone_low": zone.get("zone_low"),
            "zone_high": zone.get("zone_high"),
        }

    supports = [build_level(z, "S", i + 1) for i, z in enumerate(supports_raw)]
    resistances = [build_level(z, "R", i + 1) for i, z in enumerate(resistances_raw)]

    all_levels = supports + resistances
    closest = min(all_levels, key=lambda x: x["distance_pct"]) if all_levels else None
    strongest = max(all_levels, key=lambda x: x["strength"]) if all_levels else None

    return sanitize_json({
        "ticker": ticker,
        "current_price": round(current_price, 2),
        "timeframe_requested": timeframe,
        "basis_timeframe": basis,
        "engine": "smart_sr_v1",
        "support": supports,
        "resistance": resistances,
        "closest_alert": closest,
        "strongest_zone": strongest,
        "s1": supports[0]["level"] if len(supports) > 0 else None,
        "s2": supports[1]["level"] if len(supports) > 1 else None,
        "r1": resistances[0]["level"] if len(resistances) > 0 else None,
        "r2": resistances[1]["level"] if len(resistances) > 1 else None,
    })

@app.get("/api/chart-data")
def get_chart_data(ticker: str = "NVDA", timeframe: str = "1d"):
    ticker = normalize_ticker(ticker)
    cfg = TIMEFRAME_CONFIG.get(timeframe, TIMEFRAME_CONFIG["1d"])
    hist = get_raw_history(ticker, timeframe)

    if hist is None or hist.empty:
        return []

    hist = hist.copy()
    hist['EMA20'] = hist['Close'].ewm(span=20, adjust=False).mean()
    hist['EMA50'] = hist['Close'].ewm(span=50, adjust=False).mean()
    hist['RSI'] = calculate_rsi(hist['Close'], 14)

    is_intraday = cfg["interval"] not in ("1d", "1wk")

    data = []
    for date, row in hist.iterrows():
        if pd.isna(row['Close']):
            continue
        t = int(date.timestamp()) if is_intraday else date.strftime("%Y-%m-%d")
        vol = row['Volume'] if 'Volume' in hist.columns and not pd.isna(row.get('Volume')) else 0
        data.append({
            "time": t,
            "open": round(row['Open'], 2), "high": round(row['High'], 2),
            "low": round(row['Low'], 2), "close": round(row['Close'], 2),
            "volume": int(vol) if vol else 0,
            "ema20": round(row['EMA20'], 2) if not pd.isna(row['EMA20']) else None,
            "ema50": round(row['EMA50'], 2) if not pd.isna(row['EMA50']) else None,
            "rsi": round(row['RSI'], 2) if not pd.isna(row['RSI']) else 50
        })
    return data

# 👜 Smart Option Pocket Endpoints
# ---------------------------------------------------------------------------
def get_positions_legacy():
    for pos in logged_positions:
        tk = pos["ticker"]
        strike = float(pos["strike_price"])
        opt_type = pos["option_type"].upper()
        exp = pos["expiration"]
        premium_paid = float(pos["premium_paid"]) # ราคาพรีเมียมต่อหุ้น (เช่น 1.38)
        qty = int(pos["quantity"])
        iv = float(pos.get("iv", 0.0))

        curr_underlying = get_base_price(tk)
        current_premium = None

        # 1. ลองดึงราคาจริงจาก API
        try:
            chain = yf.Ticker(tk).option_chain(exp)
            df = chain.calls if opt_type == "CALL" else chain.puts
            opt_row = df[df['strike'] == strike]
            if not opt_row.empty:
                row = opt_row.iloc[0]
                bid, ask = row.get('bid'), row.get('ask')
                if bid and ask and bid > 0 and ask > 0:
                    current_premium = (bid + ask) / 2
                else:
                    current_premium = row.get('lastPrice')
        except Exception:
            pass

        # 2. ถ้า API ล่ม หรือหาไม่เจอ -> ใช้ Black-Scholes (ถ้าใส่ IV มา)
        if current_premium is None or current_premium <= 0:
            if iv > 0:
                try:
                    exp_date = datetime.strptime(exp, "%Y-%m-%d")
                    days_to_exp = (exp_date - datetime.now()).days
                    T = max(days_to_exp, 0) / 365.0
                    current_premium = black_scholes(curr_underlying, strike, T, 0.05, iv / 100.0, opt_type)
                except Exception:
                    pass

        # 3. Fallback สุดท้ายคือ Intrinsic Value
        if current_premium is None or current_premium <= 0:
            if opt_type == "CALL": current_premium = max(0.01, curr_underlying - strike)
            else: current_premium = max(0.01, strike - curr_underlying)

        # คำนวณ PnL โดย (ราคาพรีเมียมปัจจุบัน - ราคาพรีเมียมตอนซื้อ) * 100 * จำนวนสัญญา
        pnl = (current_premium - premium_paid) * 100 * qty
        total_cost = premium_paid * 100 * qty
        pnl_percent = (pnl / total_cost) * 100 if total_cost > 0 else 0

        pos["current_underlying_price"] = round(curr_underlying, 2)
        pos["current_option_premium"] = round(current_premium, 2)
        pos["pnl"] = round(pnl, 2)
        pos["pnl_percent"] = round(pnl_percent, 2)

    return logged_positions

def add_position_legacy(pos: ValidatedPositionModel):
    entry_price = get_base_price(pos.ticker)
    new_pos = pos.model_dump()
    new_pos["id"] = random.randint(1000, 9999)
    new_pos["entry_underlying_price"] = entry_price
    new_pos["pnl"] = 0.0
    new_pos["pnl_percent"] = 0.0
    logged_positions.append(new_pos)

    msg = f"\n🟢 [เปิดออปชัน]\nหุ้น: {pos.ticker} ({pos.option_type})\nStrike: ${pos.strike_price}\nจำนวน: {pos.quantity} สัญญา"
    send_line_alert(msg)
    return new_pos

def close_position_legacy(pos_id: int):
    global logged_positions
    pos = next((p for p in logged_positions if p["id"] == pos_id), None)
    if pos: send_line_alert(f"\n🔴 [ปิดออปชัน]\nหุ้น: {pos['ticker']} ({pos['option_type']})\nP&L: ${pos['pnl']}")
    logged_positions = [p for p in logged_positions if p["id"] != pos_id]
    return {"status": "success"}

def enrich_option_position(position: dict[str, Any]) -> dict[str, Any]:
    """Attach a current option mark without persisting ephemeral calculations.

    When a quote is unavailable, the API returns the contract with explicit
    unavailable valuation fields. It does not fabricate a market price.
    """
    pos = dict(position)
    ticker = str(pos["ticker"])
    strike = float(pos["strike_price"])
    option_type = str(pos["option_type"]).upper()
    expiration = str(pos["expiration"])
    premium_paid = float(pos["premium_paid"])
    quantity = int(pos["quantity"])
    iv = float(pos.get("iv", 0.0))

    try:
        current_underlying = get_base_price(ticker)
    except Exception:
        pos.update({
            "current_underlying_price": None,
            "current_option_premium": None,
            "pnl": None,
            "pnl_percent": None,
            "market_data_stale": True,
        })
        return pos

    current_premium = None
    valuation_source = "option_chain"
    try:
        chain = yf.Ticker(ticker).option_chain(expiration)
        options = chain.calls if option_type == "CALL" else chain.puts
        row = options[options["strike"] == strike]
        if not row.empty:
            quote = row.iloc[0]
            bid, ask = quote.get("bid"), quote.get("ask")
            if _is_valid_price(bid) and _is_valid_price(ask):
                current_premium = (float(bid) + float(ask)) / 2
            elif _is_valid_price(quote.get("lastPrice")):
                current_premium = float(quote["lastPrice"])
    except Exception:
        pass

    if not _is_valid_price(current_premium) and iv > 0:
        try:
            expiration_date = datetime.strptime(expiration, "%Y-%m-%d")
            years_to_expiry = max((expiration_date - datetime.now()).days, 0) / 365.0
            current_premium = black_scholes(
                current_underlying, strike, years_to_expiry, 0.05, iv / 100.0, option_type
            )
            valuation_source = "black_scholes_estimate"
        except Exception:
            current_premium = None

    if not _is_valid_price(current_premium):
        current_premium = (
            max(0.0, current_underlying - strike)
            if option_type == "CALL"
            else max(0.0, strike - current_underlying)
        )
        valuation_source = "intrinsic_value_estimate"

    pnl = (float(current_premium) - premium_paid) * 100 * quantity
    total_cost = premium_paid * 100 * quantity
    pos.update({
        "current_underlying_price": round(current_underlying, 2),
        "current_option_premium": round(float(current_premium), 2),
        "pnl": round(pnl, 2),
        "pnl_percent": round((pnl / total_cost) * 100, 2) if total_cost > 0 else 0.0,
        "market_data_stale": False,
        "valuation_source": valuation_source,
    })


@app.get("/api/ai-recommendation")
def get_ai_recommendation(ticker: str = "NVDA"):
    """Explainable, data-availability-aware AI terminal score for one symbol.

    This intentionally exposes the engine's inputs and confidence instead of
    presenting an unqualified trading recommendation.
    """
    ticker = normalize_ticker(ticker)
    stats = get_stats(ticker)
    call_score = float(stats.get("call_score") or 50)
    put_score = float(stats.get("put_score") or 50)
    iv_rank = float(stats.get("iv_rank") or 50)
    fair_value_upside = stats.get("fair_value_upside_pct")
    try:
        fundamental = max(0.0, min(100.0, 50.0 + float(fair_value_upside or 0)))
    except (TypeError, ValueError):
        fundamental = None
    technical = max(0.0, min(100.0, (call_score + (100.0 - put_score)) / 2.0))
    prediction = predict_ai(FactorInput(
        technical=technical,
        fundamental=fundamental,
        iv=max(0.0, min(100.0, 100.0 - iv_rank)),
        options_flow=max(0.0, min(100.0, 100.0 - put_score)),
        notes={
            "technical": "Derived from the terminal call and put technical scores.",
            "fundamental": "Derived from the available fair-value upside estimate.",
            "iv": "Lower IV rank scores as relatively more favorable; this is not a volatility forecast.",
            "options_flow": "Derived from the terminal put-versus-call scoring balance.",
        },
    ))
    signal = "Bullish" if prediction.bullish_probability >= 55 else "Bearish" if prediction.bearish_probability >= 55 else "Neutral"
    return sanitize_json({
        "ticker": ticker,
        "signal": signal,
        "bullish_probability": prediction.bullish_probability,
        "bearish_probability": prediction.bearish_probability,
        "neutral_probability": prediction.neutral_probability,
        "confidence_score": prediction.confidence_score,
        "factors_used": prediction.factors_used,
        "factors_total": prediction.factors_total,
        "reasoning": prediction.weighted_reasoning,
        "disclaimer": "Explainable analytical signal only, not investment advice or an order recommendation.",
    })


@app.get("/api/company")
@ttl_cache(ttl_seconds=300)
def get_company_snapshot(ticker: str = "NVDA"):
    """Small, provider-backed company snapshot for the stock analysis workspace."""
    ticker = normalize_ticker(ticker)
    try:
        info = yf.Ticker(ticker).info or {}
        return sanitize_json({
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName") or ticker,
            "sector": info.get("sector") or "Unavailable",
            "industry": info.get("industry") or "Unavailable",
            "exchange": info.get("exchange") or "Unavailable",
            "website": info.get("website"),
            "employees": info.get("fullTimeEmployees"),
            "summary": info.get("longBusinessSummary"),
            "market_cap": info.get("marketCap"),
            "revenue": info.get("totalRevenue"),
            "profit_margin": info.get("profitMargins"),
            "trailing_pe": info.get("trailingPE"),
            "forward_pe": info.get("forwardPE"),
            "dividend_yield": info.get("dividendYield"),
        })
    except Exception as exc:
        logger.exception("Company snapshot failed for %s", ticker)
        raise HTTPException(status_code=503, detail="Company information is temporarily unavailable.") from exc


@app.get("/api/news")
@ttl_cache(ttl_seconds=120)
def get_stock_news(ticker: str = "NVDA", limit: int = Query(8, ge=1, le=20)):
    """Return a compact, sanitized provider news feed without exposing raw payloads."""
    ticker = normalize_ticker(ticker)
    try:
        raw_items = yf.Ticker(ticker).news or []
        items = []
        for raw in raw_items:
            raw_item = raw if isinstance(raw, dict) else {}
            content = raw_item.get("content", raw_item)
            if not isinstance(content, dict):
                content = {}
            title = content.get("title") or raw_item.get("title")
            if not title:
                continue
            provider = content.get("provider", {})
            canonical = content.get("canonicalUrl", {})
            link = canonical.get("url") if isinstance(canonical, dict) else raw_item.get("link")
            items.append({
                "title": str(title)[:300],
                "publisher": provider.get("displayName") if isinstance(provider, dict) else raw_item.get("publisher"),
                "link": link if isinstance(link, str) and link.startswith(("https://", "http://")) else None,
                "published_at": content.get("pubDate") or raw_item.get("providerPublishTime"),
            })
            if len(items) >= limit:
                break
        return {"ticker": ticker, "items": items}
    except Exception as exc:
        logger.exception("News snapshot failed for %s", ticker)
        raise HTTPException(status_code=503, detail="News is temporarily unavailable.") from exc
    return pos


def get_cloud_option_positions(user: CurrentUser) -> list[dict[str, Any]]:
    """Read only the signed-in user's open option contracts."""
    with session_scope() as session:
        ensure_cloud_workspace(
            session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
        )
        return [legacy_position_payload(item) for item in list_open_option_positions(session, user.id)]


@app.get("/api/positions")
def get_positions(request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response)
    if user is None:
        enriched_positions = [enrich_option_position(item) for item in logged_positions]
        # Retain legacy in-memory behaviour, while cloud records remain
        # unchanged by a read-only valuation request.
        for stored, enriched in zip(logged_positions, enriched_positions):
            stored.update(enriched)
        return sanitize_json(enriched_positions)
    return sanitize_json([enrich_option_position(item) for item in get_cloud_option_positions(user)])


@app.post("/api/positions")
def add_position(pos: ValidatedPositionModel, request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response, mutate=True)
    try:
        entry_price = get_base_price(pos.ticker)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="A current market price is required to add this position.") from exc
    if user is None:
        new_pos = pos.model_dump()
        new_pos.update({
            "id": random.randint(1000, 9999),
            "entry_underlying_price": entry_price,
            "pnl": 0.0,
            "pnl_percent": 0.0,
        })
        logged_positions.append(new_pos)
    else:
        try:
            with session_scope() as session:
                ensure_cloud_workspace(
                    session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
                )
                stored = create_option_position(
                    session,
                    profile_id=user.id,
                    ticker=pos.ticker,
                    strike_price=pos.strike_price,
                    option_type=pos.option_type,
                    expiration=pos.expiration,
                    premium_paid=pos.premium_paid,
                    quantity=pos.quantity,
                    iv=pos.iv,
                    delta=pos.delta,
                    entry_underlying_price=entry_price,
                    portfolio_id=pos.portfolio_id,
                )
                new_pos = legacy_position_payload(stored)
        except (CloudServiceValidationError, CloudResourceNotFoundError, DefaultResourceProtectionError) as exc:
            raise_cloud_service_error(exc)

    send_line_alert(
        f"\n[Open option]\nTicker: {pos.ticker} ({pos.option_type})"
        f"\nStrike: ${pos.strike_price}\nContracts: {pos.quantity}"
    )
    return sanitize_json(enrich_option_position(new_pos))


@app.delete("/api/positions/{pos_id}")
def close_position(pos_id: int, request: Request, response: Response):
    global logged_positions
    user = get_cloud_user_or_legacy(request, response, mutate=True)
    if user is None:
        position = next((item for item in logged_positions if item["id"] == pos_id), None)
        if position is None:
            raise HTTPException(status_code=404, detail="Position not found.")
        marked = enrich_option_position(position)
        logged_positions = [item for item in logged_positions if item["id"] != pos_id]
    else:
        with session_scope() as session:
            ensure_cloud_workspace(
                session, profile_id=user.id, email=user.email, avatar_url=user.avatar_url
            )
            stored = close_option_position(session, profile_id=user.id, position_id=pos_id)
            if stored is None:
                # Use one response for a foreign and a missing ID so this API
                # cannot reveal another user's portfolio contents.
                raise HTTPException(status_code=404, detail="Position not found.")
            marked = enrich_option_position(legacy_position_payload(stored))

    send_line_alert(
        f"\n[Close option]\nTicker: {marked['ticker']} ({marked['option_type']})"
        f"\nP&L: {marked.get('pnl', 'unavailable')}"
    )
    return {"status": "success", "position": sanitize_json(marked)}


@app.websocket("/ws/price/{ticker}")
async def websocket_endpoint(websocket: WebSocket, ticker: str):
    try:
        ticker = normalize_ticker(ticker)
    except HTTPException:
        await websocket.close(code=1008, reason="Invalid ticker")
        return

    try:
        await quote_hub.subscribe(ticker, websocket)
        while True:
            # The server sends quotes; receive only keeps disconnect detection
            # reliable without requiring browser timers to stay active.
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    except LiveQuoteHubCapacityError:
        # The socket was accepted so the browser receives an explicit retryable
        # close code instead of keeping an unbounded ticker worker alive.
        await websocket.close(code=1013, reason="Live quote capacity reached")
    except Exception as exc:
        logger.info("Live socket closed for %s: %s", ticker, exc)
    finally:
        # ``subscribe`` may have registered the socket before a cached-payload
        # send fails. Unsubscribe is idempotent, so always clean it up.
        await quote_hub.unsubscribe(ticker, websocket)

# ---------------------------------------------------------------------------
# 🔮 What-If Simulator API
# ---------------------------------------------------------------------------
class SimulatorModel(BaseModel):
    """Validated inputs for the single-scenario What-If calculator."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    strike_price: float = Field(gt=0, le=1_000_000_000)
    option_type: Literal["CALL", "PUT"]
    expiration: date
    premium_paid: float = Field(gt=0, le=1_000_000_000)
    current_iv: float = Field(gt=0, le=500)
    target_price: float = Field(gt=0, le=1_000_000_000)
    target_date: date

@app.post("/api/simulate")
def simulate_option(data: SimulatorModel):
    try:
        # คำนวณวันหมดอายุ และจำนวนวันที่เหลือจนถึงเป้าหมาย
        days_to_exp = (data.expiration - data.target_date).days
        if days_to_exp < 0:
            return {"error": "วันที่ตั้งเป้าหมาย ต้องไม่เกินวันหมดอายุของสัญญา!"}

        T = days_to_exp / 365.0
        r = 0.05 # กำหนด Risk-free rate ที่ 5%
        sigma = data.current_iv / 100.0 # แปลง IV จากเปอร์เซ็นต์เป็นทศนิยม

        # Black-Scholes หัก Time Decay (Theta)
        simulated_premium = black_scholes(data.target_price, data.strike_price, T, r, sigma, data.option_type)

        # คำนวณกำไร/ขาดทุน
        pnl_per_share = simulated_premium - data.premium_paid
        pnl_total = pnl_per_share * 100 # กำไรสุทธิต่อ 1 สัญญา (100 หุ้น)
        pnl_percent = (pnl_per_share / data.premium_paid) * 100 if data.premium_paid > 0 else 0

        # คำนวณจุดคุ้มทุน (Break-even)
        break_even = data.strike_price + data.premium_paid if data.option_type == "CALL" else data.strike_price - data.premium_paid

        return {
            "simulated_premium": round(simulated_premium, 2),
            "pnl_total": round(pnl_total, 2),
            "pnl_percent": round(pnl_percent, 2),
            "days_remaining": days_to_exp,
            "break_even": round(break_even, 2)
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Option simulation failed")
        raise HTTPException(status_code=503, detail="Simulation data is temporarily unavailable.") from exc


@ttl_cache(ttl_seconds=120)
def get_options_chain_summary(ticker: str) -> Optional[dict]:
    """Aggregate OI/volume across calls & puts for the nearest expiration.
    Returns None (not a guessed number) if no chain is available."""
    try:
        stock = yf.Ticker(ticker)
        exps = stock.options
        if not exps:
            return None
        chain = stock.option_chain(exps[0])
        calls, puts = chain.calls, chain.puts
        return {
            "call_oi": int(calls["openInterest"].fillna(0).sum()),
            "put_oi": int(puts["openInterest"].fillna(0).sum()),
            "call_volume": int(calls["volume"].fillna(0).sum()),
            "put_volume": int(puts["volume"].fillna(0).sum()),
            "net_gamma_notional": None,  # requires a licensed dealer-flow feed; not estimated from OI alone
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 🏛️ Phase 5 — Institutional Engines: Gauges / AI Prediction / Advanced Simulator
# ---------------------------------------------------------------------------
@app.get("/api/gauges")
def get_gauges(
    request: Request,
    response: Response,
    ticker: str = "NVDA",
    account_size: float = Query(100_000.0, gt=0, le=1_000_000_000),
):
    try:
        ticker = normalize_ticker(ticker)
        stats = stats_engine.analyze_key_statistics(ticker)

        user = get_cloud_user_or_legacy(request, response)
        position_source = logged_positions if user is None else get_cloud_option_positions(user)
        ticker_positions = [p for p in position_source if p["ticker"].upper() == ticker]
        pg = portfolio_engine.compute_portfolio_greeks(ticker_positions, get_underlying_price=get_base_price)
        portfolio_greeks = None
        if pg["position_count"] > 0:
            portfolio_greeks = {"net_theta": pg["net_theta"], "net_vega": pg["net_vega"], "net_gamma": pg["net_gamma"]}

        chain_summary = get_options_chain_summary(ticker)
        current_iv = stats.get("current_iv") or 0.30

        gauges = gauges_engine.compute_gauges(
            technical_indicators=stats.get("indicators", {}),
            ratings=stats.get("ratings", {}),
            current_iv=current_iv,
            iv_history=stats.get("iv_history", []),
            portfolio_greeks=portfolio_greeks,
            account_size=account_size,
            options_chain_summary=chain_summary,
        )
        return sanitize_json({"ticker": ticker, "gauges": gauges, "portfolio_context": pg})
    except HTTPException:
        # Authentication, authorization, validation, and data-unavailable
        # statuses have already been deliberately classified by their source.
        raise
    except Exception as exc:
        logger.exception("Gauges endpoint failed for %s", ticker)
        raise HTTPException(status_code=500, detail="Unable to calculate gauges right now.") from exc



class SimScenarioModel(BaseModel):
    """Validated inputs for the bounded advanced Monte Carlo endpoint."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    label: str = Field(default="Scenario", min_length=1, max_length=120)
    strike_price: float = Field(gt=0, le=1_000_000_000)
    option_type: Literal["CALL", "PUT"] = "CALL"
    expiration: date
    target_date: date
    premium_paid: float = Field(default=0.0, ge=0, le=1_000_000_000)
    current_iv: float = Field(default=30.0, gt=0, le=500)  # percent, e.g. 42.5
    quantity: int = Field(default=1, ge=1, le=10_000)
    r: float = Field(default=0.05, ge=-0.5, le=1.0)
    q: float = Field(default=0.0, ge=0, le=1.0)
    iv_shock_pts: float = Field(default=0.0, ge=-500, le=500)
    rate_shock_pts: float = Field(default=0.0, ge=-150, le=150)
    dividend_shock_pts: float = Field(default=0.0, ge=-100, le=100)
    n_sims: int = Field(default=10_000, ge=1_000, le=50_000)
    target_price_override: Optional[float] = Field(default=None, gt=0, le=1_000_000_000)


class AdvancedSimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticker: str = Field(min_length=1, max_length=12)
    scenarios: list[SimScenarioModel] = Field(min_length=1, max_length=10)

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, value: str) -> str:
        return normalize_ticker(value)


@app.post("/api/simulate-advanced")
def simulate_advanced(req: AdvancedSimulateRequest):
    try:
        total_simulations = sum(scenario.n_sims for scenario in req.scenarios)
        if total_simulations > 100_000:
            raise HTTPException(
                status_code=422,
                detail="Total simulations must not exceed 100000 per request.",
            )
        S0 = get_base_price(req.ticker)
        today = date.today()
        scenario_inputs = []
        for s in req.scenarios:
            T_days_now = max((s.expiration - today).days, 0)
            target_days_from_now = max((s.target_date - today).days, 0)
            if target_days_from_now > T_days_now:
                raise HTTPException(
                    status_code=422,
                    detail=f"[{s.label}] target date is after expiration",
                )

            scenario_inputs.append(ScenarioInput(
                label=s.label,
                S0=s.target_price_override if s.target_price_override is not None else S0,
                K=s.strike_price,
                T_days_now=T_days_now,
                target_days_from_now=target_days_from_now,
                r=s.r, sigma=s.current_iv / 100.0, q=s.q,
                option_type=s.option_type, premium_paid=s.premium_paid,
                quantity=s.quantity, n_sims=s.n_sims,
                iv_shock_pts=s.iv_shock_pts, rate_shock_pts=s.rate_shock_pts,
                dividend_shock_pts=s.dividend_shock_pts,
            ))

        results = run_multi_scenario(scenario_inputs)
        return {"ticker": req.ticker, "underlying_price": S0,
                "results": [jsonable_encoder(r) for r in results]}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Advanced simulation failed for %s", req.ticker)
        raise HTTPException(status_code=503, detail="Simulation data is temporarily unavailable.") from exc


@app.get("/api/portfolio/greeks")
def get_portfolio_greeks(request: Request, response: Response):
    user = get_cloud_user_or_legacy(request, response)
    position_source = logged_positions if user is None else get_cloud_option_positions(user)
    pg = portfolio_engine.compute_portfolio_greeks(position_source, get_underlying_price=get_base_price)
    return pg


@app.get("/api/debug/yfinance", include_in_schema=False)
def debug_yfinance(request: Request, ticker: str = "NVDA"):
    """Diagnostic endpoint: calls yfinance directly and returns the raw
    exception (type + message) instead of silently falling back, so we can
    see exactly why price/stats data isn't loading on this host."""
    require_operational_access(request)
    ticker = normalize_ticker(ticker)
    import traceback
    result = {"ticker": ticker, "yfinance_version": getattr(yf, "__version__", "unknown")}
    try:
        stock = yf.Ticker(ticker)
        info = stock.info
        result["info_ok"] = True
        result["info_keys_sample"] = list(info.keys())[:5] if info else []
        result["regularMarketPrice"] = info.get("regularMarketPrice")
    except Exception as e:
        result["info_ok"] = False
        result["info_error_type"] = type(e).__name__
        result["info_error_message"] = str(e)
        result["info_traceback"] = traceback.format_exc()[-1500:]

    try:
        hist = yf.Ticker(ticker).history(period="5d", interval="1d")
        result["history_ok"] = not hist.empty
        result["history_rows"] = len(hist)
    except Exception as e:
        result["history_ok"] = False
        result["history_error_type"] = type(e).__name__
        result["history_error_message"] = str(e)

    return result


@app.get("/api/cache/stats", include_in_schema=False)
def cache_stats(request: Request):
    require_operational_access(request)
    return get_cache_stats()


@app.delete("/api/cache", include_in_schema=False)
def cache_clear(request: Request):
    require_operational_access(request)
    clear_all_cache()
    return {"status": "cleared"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )
