"""Durable alert and notification-inbox primitives.

This module deliberately has no scheduler, WebSocket, or market-data client.
An authenticated API route can manage rules through the ownership-scoped CRUD
functions, while a separate worker can pass an already-fetched quote/news/
earnings observation to :func:`evaluate_alert`.  That separation prevents a
browser tab from being the source of truth for alerts.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Alert, NotificationEvent


ALERT_TYPES = frozenset({"price", "support_resistance", "iv", "news", "earnings"})
ALERT_CONDITIONS: dict[str, frozenset[str]] = {
    "price": frozenset({"above", "below", "crosses_above", "crosses_below"}),
    "support_resistance": frozenset({"breakout", "breakdown", "bounce"}),
    "iv": frozenset({"above", "below", "crosses_above", "crosses_below"}),
    "news": frozenset({"matched"}),
    "earnings": frozenset({"within_days", "reported"}),
}
NOTIFICATION_TYPES = ALERT_TYPES | {"system"}
SEVERITIES = frozenset({"info", "success", "warning", "critical"})
DELIVERY_STATUSES = frozenset({"in_app", "pending", "delivered", "failed"})
DELIVERY_CHANNELS = frozenset({"in_app", "push", "email"})

MAX_ALERT_NAME_LENGTH = 120
MAX_EVENT_TITLE_LENGTH = 160
MAX_EVENT_BODY_LENGTH = 4_000
MAX_DEDUPE_KEY_LENGTH = 160
MAX_DELIVERY_ERROR_LENGTH = 500
MAX_COOLDOWN_SECONDS = 604_800
DEFAULT_COOLDOWN_SECONDS = 300
DEFAULT_BOUNCE_TOLERANCE = Decimal("0.002")
_TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,11}$")


class AlertServiceValidationError(ValueError):
    """The value cannot be stored or evaluated safely."""


class AlertResourceNotFoundError(LookupError):
    """The requested alert/event is not owned by the authenticated profile."""


@dataclass(frozen=True, slots=True)
class AlertDefinition:
    """Normalized, database-ready alert rule without per-run state."""

    name: str
    alert_type: str
    condition: str
    ticker: str | None
    target_value: Decimal | None
    config_json: dict[str, Any]
    delivery_channels: tuple[str, ...]
    is_enabled: bool
    cooldown_seconds: int
    expires_at: datetime | None


@dataclass(frozen=True, slots=True)
class AlertEvaluation:
    """Pure result of evaluating one rule against supplied observations."""

    matched: bool
    reason: str
    evaluated_at: datetime
    observed_value: Decimal | None
    previous_value: Decimal | None
    payload: dict[str, Any]


def _normalize_token(value: Any, *, field: str, allowed: frozenset[str]) -> str:
    if not isinstance(value, str):
        raise AlertServiceValidationError(f"{field} must be text")
    normalized = value.strip().lower()
    if normalized not in allowed:
        choices = ", ".join(sorted(allowed))
        raise AlertServiceValidationError(f"{field} must be one of: {choices}")
    return normalized


def _normalize_text(value: Any, *, field: str, maximum: int, allow_none: bool = False) -> str | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str):
        raise AlertServiceValidationError(f"{field} must be text")
    normalized = value.strip()
    if not normalized:
        if allow_none:
            return None
        raise AlertServiceValidationError(f"{field} is required")
    if len(normalized) > maximum:
        raise AlertServiceValidationError(f"{field} must be at most {maximum} characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise AlertServiceValidationError(f"{field} cannot contain control characters")
    return normalized


def normalize_alert_ticker(value: Any, *, required: bool = False) -> str | None:
    """Normalize a ticker, retaining ``None`` for global news rules."""

    if value is None:
        if required:
            raise AlertServiceValidationError("ticker is required for this alert type")
        return None
    if not isinstance(value, str):
        raise AlertServiceValidationError("ticker must be text")
    normalized = value.strip().upper()
    if not _TICKER_PATTERN.fullmatch(normalized):
        raise AlertServiceValidationError(
            "ticker must be 1-12 uppercase letters, digits, dots, or hyphens"
        )
    return normalized


def _as_decimal(value: Any, *, field: str, allow_none: bool = False) -> Decimal | None:
    if value is None:
        if allow_none:
            return None
        raise AlertServiceValidationError(f"{field} is required")
    if isinstance(value, bool):
        raise AlertServiceValidationError(f"{field} must be numeric")
    try:
        normalized = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise AlertServiceValidationError(f"{field} must be numeric") from None
    if not normalized.is_finite():
        raise AlertServiceValidationError(f"{field} must be finite")
    return normalized


def _require_nonnegative(value: Decimal, *, field: str) -> Decimal:
    if value < 0:
        raise AlertServiceValidationError(f"{field} must be zero or greater")
    return value


def _require_numeric_24_8(value: Decimal, *, field: str) -> Decimal:
    """Keep API validation aligned with PostgreSQL ``NUMERIC(24, 8)``."""

    if value.as_tuple().exponent < -8:
        raise AlertServiceValidationError(f"{field} may have at most 8 decimal places")
    if value != 0 and value.adjusted() > 15:
        raise AlertServiceValidationError(f"{field} exceeds the supported numeric range")
    return value


def _normalize_datetime(value: Any, *, field: str, allow_none: bool = False) -> datetime | None:
    if value is None:
        if allow_none:
            return None
        raise AlertServiceValidationError(f"{field} is required")
    if not isinstance(value, datetime):
        raise AlertServiceValidationError(f"{field} must be a datetime")
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _normalize_bool(value: Any, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise AlertServiceValidationError(f"{field} must be true or false")
    return value


def _normalize_cooldown(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise AlertServiceValidationError("cooldown_seconds must be an integer")
    if not 0 <= value <= MAX_COOLDOWN_SECONDS:
        raise AlertServiceValidationError(
            f"cooldown_seconds must be between 0 and {MAX_COOLDOWN_SECONDS}"
        )
    return value


def _normalize_json_value(value: Any, *, field: str, depth: int = 0) -> Any:
    if depth > 12:
        raise AlertServiceValidationError(f"{field} is nested too deeply")
    if value is None or isinstance(value, (str, bool, int)):
        if isinstance(value, str) and len(value) > 5_000:
            raise AlertServiceValidationError(f"{field} contains a string that is too long")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise AlertServiceValidationError(f"{field} cannot contain non-finite numbers")
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise AlertServiceValidationError(f"{field} cannot contain non-finite numbers")
        return format(value, "f")
    if isinstance(value, Mapping):
        if len(value) > 100:
            raise AlertServiceValidationError(f"{field} contains too many keys")
        normalized: dict[str, Any] = {}
        for key, nested_value in value.items():
            if not isinstance(key, str) or not key or len(key) > 120:
                raise AlertServiceValidationError(f"{field} keys must be 1-120 character text")
            normalized[key] = _normalize_json_value(nested_value, field=field, depth=depth + 1)
        return normalized
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        if len(value) > 100:
            raise AlertServiceValidationError(f"{field} contains too many items")
        return [_normalize_json_value(item, field=field, depth=depth + 1) for item in value]
    raise AlertServiceValidationError(f"{field} must be JSON-compatible")


def _normalize_json_object(value: Any, *, field: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise AlertServiceValidationError(f"{field} must be an object")
    normalized = _normalize_json_value(value, field=field)
    assert isinstance(normalized, dict)
    try:
        serialized = json.dumps(normalized, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        raise AlertServiceValidationError(f"{field} must be JSON-compatible") from None
    if len(serialized.encode("utf-8")) > 20_000:
        raise AlertServiceValidationError(f"{field} must be at most 20 KB")
    return normalized


def _normalize_delivery_channels(value: Any) -> tuple[str, ...]:
    if value is None:
        return ("in_app",)
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise AlertServiceValidationError("delivery_channels must be a list")
    normalized: list[str] = []
    for channel in value:
        normalized_channel = _normalize_token(
            channel, field="delivery_channels", allowed=DELIVERY_CHANNELS
        )
        if normalized_channel not in normalized:
            normalized.append(normalized_channel)
    if not normalized:
        raise AlertServiceValidationError("delivery_channels must include at least one channel")
    return tuple(normalized)


def _default_alert_name(alert_type: str, condition: str, ticker: str | None) -> str:
    subject = ticker or "Market"
    return f"{subject} {alert_type.replace('_', ' ')} {condition.replace('_', ' ')}"


def normalize_alert_definition(value: Mapping[str, Any] | AlertDefinition) -> AlertDefinition:
    """Validate a complete alert specification before it reaches the ORM.

    Required keys are ``alert_type`` and ``condition``.  ``ticker`` is
    required for quote-derived alerts and optional only for news alerts.
    Numeric target values are required for price, support/resistance, IV, and
    ``earnings/within_days`` rules.
    """

    if isinstance(value, AlertDefinition):
        return value
    if not isinstance(value, Mapping):
        raise AlertServiceValidationError("alert definition must be an object")

    alert_type = _normalize_token(value.get("alert_type"), field="alert_type", allowed=ALERT_TYPES)
    allowed_conditions = ALERT_CONDITIONS[alert_type]
    condition = _normalize_token(value.get("condition"), field="condition", allowed=allowed_conditions)
    ticker = normalize_alert_ticker(value.get("ticker"), required=alert_type != "news")

    raw_target = value.get("target_value")
    requires_target = alert_type in {"price", "support_resistance", "iv"} or (
        alert_type == "earnings" and condition == "within_days"
    )
    if requires_target:
        target_value = _require_numeric_24_8(
            _require_nonnegative(
                _as_decimal(raw_target, field="target_value"), field="target_value"
            ),
            field="target_value",
        )
        if alert_type == "earnings" and target_value != target_value.to_integral_value():
            raise AlertServiceValidationError("earnings target_value must be a whole number of days")
    else:
        if raw_target is not None:
            raise AlertServiceValidationError("target_value is not used by this alert condition")
        target_value = None

    raw_config = value.get("config", value.get("config_json"))
    config_json = _normalize_json_object(raw_config, field="config")
    if condition == "bounce" and "tolerance_percent" in config_json:
        tolerance = _require_nonnegative(
            _as_decimal(config_json["tolerance_percent"], field="config.tolerance_percent"),
            field="config.tolerance_percent",
        )
        if tolerance > Decimal("0.20"):
            raise AlertServiceValidationError("config.tolerance_percent must be at most 0.20")
        config_json["tolerance_percent"] = format(tolerance, "f")

    raw_name = value.get("name")
    name = (
        _default_alert_name(alert_type, condition, ticker)
        if raw_name is None
        else _normalize_text(raw_name, field="name", maximum=MAX_ALERT_NAME_LENGTH)
    )
    assert isinstance(name, str)
    delivery_channels = _normalize_delivery_channels(value.get("delivery_channels"))
    is_enabled = _normalize_bool(value.get("is_enabled", True), field="is_enabled")
    cooldown_seconds = _normalize_cooldown(value.get("cooldown_seconds", DEFAULT_COOLDOWN_SECONDS))
    expires_at = _normalize_datetime(value.get("expires_at"), field="expires_at", allow_none=True)

    return AlertDefinition(
        name=name,
        alert_type=alert_type,
        condition=condition,
        ticker=ticker,
        target_value=target_value,
        config_json=config_json,
        delivery_channels=delivery_channels,
        is_enabled=is_enabled,
        cooldown_seconds=cooldown_seconds,
        expires_at=expires_at,
    )


def _require_profile_id(profile_id: uuid.UUID) -> uuid.UUID:
    if not isinstance(profile_id, uuid.UUID):
        raise AlertServiceValidationError("profile_id must be a UUID")
    return profile_id


def _require_resource_id(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AlertServiceValidationError(f"{field} must be a positive integer")
    return value


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _decimal_payload(value: Decimal | None) -> str | None:
    return format(value, "f") if value is not None else None


def alert_payload(alert: Alert) -> dict[str, Any]:
    """Convert an ORM alert to a stable, JSON-ready API payload."""

    return {
        "id": int(alert.id),
        "name": alert.name,
        "alert_type": alert.alert_type,
        "condition": alert.condition,
        "ticker": alert.ticker,
        "target_value": _decimal_payload(alert.target_value),
        "config": dict(alert.config_json or {}),
        "delivery_channels": list(alert.delivery_channels or ["in_app"]),
        "is_enabled": bool(alert.is_enabled),
        "cooldown_seconds": int(alert.cooldown_seconds),
        "trigger_count": int(alert.trigger_count),
        "last_evaluated_at": _iso(alert.last_evaluated_at),
        "last_triggered_at": _iso(alert.last_triggered_at),
        "expires_at": _iso(alert.expires_at),
        "created_at": _iso(alert.created_at),
        "updated_at": _iso(alert.updated_at),
    }


def notification_event_payload(event: NotificationEvent) -> dict[str, Any]:
    """Convert an inbox event to a stable, JSON-ready API payload."""

    return {
        "id": int(event.id),
        "alert_id": int(event.alert_id) if event.alert_id is not None else None,
        "notification_type": event.notification_type,
        "severity": event.severity,
        "title": event.title,
        "body": event.body,
        "ticker": event.ticker,
        "payload": dict(event.payload_json or {}),
        "delivery_status": event.delivery_status,
        "dedupe_key": event.dedupe_key,
        "read_at": _iso(event.read_at),
        "delivered_at": _iso(event.delivered_at),
        "failed_at": _iso(event.failed_at),
        "delivery_error": event.delivery_error,
        "created_at": _iso(event.created_at),
    }


def get_alert_for_profile(
    session: Session,
    *,
    profile_id: uuid.UUID,
    alert_id: int,
    for_update: bool = False,
) -> Alert:
    """Fetch an alert only when it belongs to ``profile_id``."""

    profile_id = _require_profile_id(profile_id)
    alert_id = _require_resource_id(alert_id, field="alert_id")
    if not isinstance(for_update, bool):
        raise AlertServiceValidationError("for_update must be true or false")
    statement = select(Alert).where(Alert.id == alert_id, Alert.profile_id == profile_id)
    if for_update:
        statement = statement.with_for_update()
    alert = session.scalar(statement)
    if alert is None:
        raise AlertResourceNotFoundError("alert not found")
    return alert


def list_alerts(
    session: Session,
    *,
    profile_id: uuid.UUID,
    include_disabled: bool = True,
) -> list[Alert]:
    """List alerts strictly inside one authenticated profile boundary."""

    profile_id = _require_profile_id(profile_id)
    if not isinstance(include_disabled, bool):
        raise AlertServiceValidationError("include_disabled must be true or false")
    statement = select(Alert).where(Alert.profile_id == profile_id)
    if not include_disabled:
        statement = statement.where(Alert.is_enabled.is_(True))
    return list(session.scalars(statement.order_by(Alert.is_enabled.desc(), Alert.created_at.desc(), Alert.id.desc())))


def create_alert(
    session: Session,
    *,
    profile_id: uuid.UUID,
    definition: Mapping[str, Any] | AlertDefinition,
) -> Alert:
    """Persist a validated alert for exactly one profile."""

    profile_id = _require_profile_id(profile_id)
    normalized = normalize_alert_definition(definition)
    alert = Alert(
        profile_id=profile_id,
        name=normalized.name,
        alert_type=normalized.alert_type,
        condition=normalized.condition,
        ticker=normalized.ticker,
        target_value=normalized.target_value,
        config_json=normalized.config_json,
        delivery_channels=list(normalized.delivery_channels),
        is_enabled=normalized.is_enabled,
        cooldown_seconds=normalized.cooldown_seconds,
        expires_at=normalized.expires_at,
    )
    session.add(alert)
    session.flush()
    return alert


def _definition_from_alert(alert: Alert) -> dict[str, Any]:
    return {
        "name": alert.name,
        "alert_type": alert.alert_type,
        "condition": alert.condition,
        "ticker": alert.ticker,
        "target_value": alert.target_value,
        "config": dict(alert.config_json or {}),
        "delivery_channels": list(alert.delivery_channels or ["in_app"]),
        "is_enabled": bool(alert.is_enabled),
        "cooldown_seconds": int(alert.cooldown_seconds),
        "expires_at": alert.expires_at,
    }


def update_alert(
    session: Session,
    *,
    profile_id: uuid.UUID,
    alert_id: int,
    changes: Mapping[str, Any],
) -> Alert:
    """Update a rule after ownership validation, never accepting runtime state."""

    if not isinstance(changes, Mapping):
        raise AlertServiceValidationError("changes must be an object")
    if any(not isinstance(key, str) for key in changes):
        raise AlertServiceValidationError("alert field names must be text")
    allowed = {
        "name",
        "alert_type",
        "condition",
        "ticker",
        "target_value",
        "config",
        "config_json",
        "delivery_channels",
        "is_enabled",
        "cooldown_seconds",
        "expires_at",
    }
    unknown = set(changes) - allowed
    if unknown:
        raise AlertServiceValidationError(f"unsupported alert fields: {', '.join(sorted(unknown))}")
    if "config" in changes and "config_json" in changes:
        raise AlertServiceValidationError("pass either config or config_json, not both")

    alert = get_alert_for_profile(
        session, profile_id=profile_id, alert_id=alert_id, for_update=True
    )
    merged = _definition_from_alert(alert)
    for key, value in changes.items():
        merged["config" if key == "config_json" else key] = value
    normalized = normalize_alert_definition(merged)
    alert.name = normalized.name
    alert.alert_type = normalized.alert_type
    alert.condition = normalized.condition
    alert.ticker = normalized.ticker
    alert.target_value = normalized.target_value
    alert.config_json = normalized.config_json
    alert.delivery_channels = list(normalized.delivery_channels)
    alert.is_enabled = normalized.is_enabled
    alert.cooldown_seconds = normalized.cooldown_seconds
    alert.expires_at = normalized.expires_at
    session.flush()
    return alert


def delete_alert(session: Session, *, profile_id: uuid.UUID, alert_id: int) -> None:
    """Delete a user-owned rule while retaining historical inbox events."""

    alert = get_alert_for_profile(session, profile_id=profile_id, alert_id=alert_id)
    session.delete(alert)
    session.flush()


def mark_alert_evaluated(
    session: Session,
    *,
    profile_id: uuid.UUID,
    alert_id: int,
    evaluated_at: datetime | None = None,
) -> Alert:
    """Persist evaluation cadence separately from whether a rule matched."""

    alert = get_alert_for_profile(session, profile_id=profile_id, alert_id=alert_id)
    alert.last_evaluated_at = _normalize_datetime(
        evaluated_at or datetime.now(timezone.utc), field="evaluated_at"
    )
    session.flush()
    return alert


def _get_notification_event_for_profile(
    session: Session, *, profile_id: uuid.UUID, event_id: int
) -> NotificationEvent:
    profile_id = _require_profile_id(profile_id)
    event_id = _require_resource_id(event_id, field="event_id")
    event = session.scalar(
        select(NotificationEvent).where(
            NotificationEvent.id == event_id,
            NotificationEvent.profile_id == profile_id,
        )
    )
    if event is None:
        raise AlertResourceNotFoundError("notification event not found")
    return event


def list_notification_events(
    session: Session,
    *,
    profile_id: uuid.UUID,
    unread_only: bool = False,
    limit: int = 50,
) -> list[NotificationEvent]:
    """Read a bounded, profile-scoped notification inbox page."""

    profile_id = _require_profile_id(profile_id)
    if not isinstance(unread_only, bool):
        raise AlertServiceValidationError("unread_only must be true or false")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise AlertServiceValidationError("limit must be an integer between 1 and 200")
    statement = select(NotificationEvent).where(NotificationEvent.profile_id == profile_id)
    if unread_only:
        statement = statement.where(NotificationEvent.read_at.is_(None))
    return list(
        session.scalars(
            statement.order_by(NotificationEvent.created_at.desc(), NotificationEvent.id.desc()).limit(limit)
        )
    )


def count_unread_notification_events(session: Session, *, profile_id: uuid.UUID) -> int:
    """Return the full profile-scoped unread total for a compact UI badge."""

    profile_id = _require_profile_id(profile_id)
    count = session.scalar(
        select(func.count(NotificationEvent.id)).where(
            NotificationEvent.profile_id == profile_id,
            NotificationEvent.read_at.is_(None),
        )
    )
    return int(count or 0)


def _normalize_dedupe_key(value: Any) -> str | None:
    return _normalize_text(
        value, field="dedupe_key", maximum=MAX_DEDUPE_KEY_LENGTH, allow_none=True
    )


def _existing_deduped_event(
    session: Session, *, profile_id: uuid.UUID, dedupe_key: str | None
) -> NotificationEvent | None:
    if dedupe_key is None:
        return None
    return session.scalar(
        select(NotificationEvent).where(
            NotificationEvent.profile_id == profile_id,
            NotificationEvent.dedupe_key == dedupe_key,
        )
    )


def _record_notification_event(
    session: Session,
    *,
    profile_id: uuid.UUID,
    notification_type: str,
    title: str,
    body: str | None = None,
    ticker: str | None = None,
    alert_id: int | None = None,
    severity: str = "info",
    payload: Mapping[str, Any] | None = None,
    delivery_status: str = "in_app",
    dedupe_key: str | None = None,
    delivered_at: datetime | None = None,
    failed_at: datetime | None = None,
    delivery_error: str | None = None,
) -> tuple[NotificationEvent, bool]:
    """Append an ownership-scoped inbox event with optional idempotency key."""

    profile_id = _require_profile_id(profile_id)
    notification_type = _normalize_token(
        notification_type, field="notification_type", allowed=NOTIFICATION_TYPES
    )
    severity = _normalize_token(severity, field="severity", allowed=SEVERITIES)
    delivery_status = _normalize_token(
        delivery_status, field="delivery_status", allowed=DELIVERY_STATUSES
    )
    title = _normalize_text(title, field="title", maximum=MAX_EVENT_TITLE_LENGTH)
    assert isinstance(title, str)
    body = _normalize_text(body, field="body", maximum=MAX_EVENT_BODY_LENGTH, allow_none=True)
    ticker = normalize_alert_ticker(ticker)
    payload_json = _normalize_json_object(payload, field="payload")
    dedupe_key = _normalize_dedupe_key(dedupe_key)
    delivery_error = _normalize_text(
        delivery_error,
        field="delivery_error",
        maximum=MAX_DELIVERY_ERROR_LENGTH,
        allow_none=True,
    )
    delivered_at = _normalize_datetime(delivered_at, field="delivered_at", allow_none=True)
    failed_at = _normalize_datetime(failed_at, field="failed_at", allow_none=True)
    linked_alert: Alert | None = None
    if alert_id is not None:
        alert_id = _require_resource_id(alert_id, field="alert_id")
        linked_alert = get_alert_for_profile(session, profile_id=profile_id, alert_id=alert_id)
        if ticker is None:
            ticker = linked_alert.ticker
        elif linked_alert.ticker is not None and ticker != linked_alert.ticker:
            raise AlertServiceValidationError("ticker must match the linked alert")

    existing = _existing_deduped_event(session, profile_id=profile_id, dedupe_key=dedupe_key)
    if existing is not None:
        return existing, False
    event = NotificationEvent(
        profile_id=profile_id,
        alert_id=alert_id,
        notification_type=notification_type,
        severity=severity,
        title=title,
        body=body,
        ticker=ticker,
        payload_json=payload_json,
        delivery_status=delivery_status,
        dedupe_key=dedupe_key,
        delivered_at=delivered_at,
        failed_at=failed_at,
        delivery_error=delivery_error,
    )
    # A unique partial index also protects a two-tab/worker race.  The nested
    # transaction lets the caller continue using its surrounding transaction.
    try:
        with session.begin_nested():
            session.add(event)
            session.flush()
    except IntegrityError:
        existing = _existing_deduped_event(session, profile_id=profile_id, dedupe_key=dedupe_key)
        if existing is None:
            raise
        return existing, False
    return event, True


def record_notification_event(
    session: Session,
    *,
    profile_id: uuid.UUID,
    notification_type: str,
    title: str,
    body: str | None = None,
    ticker: str | None = None,
    alert_id: int | None = None,
    severity: str = "info",
    payload: Mapping[str, Any] | None = None,
    delivery_status: str = "in_app",
    dedupe_key: str | None = None,
    delivered_at: datetime | None = None,
    failed_at: datetime | None = None,
    delivery_error: str | None = None,
) -> NotificationEvent:
    """Append an ownership-scoped inbox event with optional idempotency key."""

    event, _created = _record_notification_event(
        session,
        profile_id=profile_id,
        notification_type=notification_type,
        title=title,
        body=body,
        ticker=ticker,
        alert_id=alert_id,
        severity=severity,
        payload=payload,
        delivery_status=delivery_status,
        dedupe_key=dedupe_key,
        delivered_at=delivered_at,
        failed_at=failed_at,
        delivery_error=delivery_error,
    )
    return event


def mark_notification_read(
    session: Session,
    *,
    profile_id: uuid.UUID,
    event_id: int,
    read_at: datetime | None = None,
) -> NotificationEvent:
    """Mark exactly one owned inbox event as read."""

    event = _get_notification_event_for_profile(session, profile_id=profile_id, event_id=event_id)
    event.read_at = _normalize_datetime(read_at or datetime.now(timezone.utc), field="read_at")
    session.flush()
    return event


def mark_all_notifications_read(
    session: Session,
    *,
    profile_id: uuid.UUID,
    read_at: datetime | None = None,
) -> int:
    """Mark all currently unread events owned by one profile as read."""

    profile_id = _require_profile_id(profile_id)
    timestamp = _normalize_datetime(read_at or datetime.now(timezone.utc), field="read_at")
    events = list(
        session.scalars(
            select(NotificationEvent).where(
                NotificationEvent.profile_id == profile_id,
                NotificationEvent.read_at.is_(None),
            )
        )
    )
    for event in events:
        event.read_at = timestamp
    if events:
        session.flush()
    return len(events)


def delete_notification_event(session: Session, *, profile_id: uuid.UUID, event_id: int) -> None:
    """Remove one owned inbox event; this does not affect its alert rule."""

    event = _get_notification_event_for_profile(session, profile_id=profile_id, event_id=event_id)
    session.delete(event)
    session.flush()


def _quote_decimal(quote: Mapping[str, Any], key: str) -> Decimal | None:
    value = quote.get(key)
    if value is None:
        return None
    try:
        normalized = _as_decimal(value, field=key)
    except AlertServiceValidationError:
        return None
    assert normalized is not None
    return normalized


def _quote_flag(quote: Mapping[str, Any], *keys: str) -> bool | None:
    for key in keys:
        if key not in quote:
            continue
        value = quote[key]
        if isinstance(value, bool):
            return value
        return None
    return None


def _event_payload(
    definition: AlertDefinition,
    *,
    observed_value: Decimal | None,
    previous_value: Decimal | None,
    quote: Mapping[str, Any],
    evaluated_at: datetime,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "alert_type": definition.alert_type,
        "condition": definition.condition,
        "ticker": definition.ticker,
        "target_value": _decimal_payload(definition.target_value),
        "observed_value": _decimal_payload(observed_value),
        "previous_value": _decimal_payload(previous_value),
        "evaluated_at": evaluated_at.isoformat(),
    }
    quote_timestamp = quote.get("updated_at")
    if isinstance(quote_timestamp, datetime):
        payload["quote_updated_at"] = _normalize_datetime(
            quote_timestamp, field="quote.updated_at"
        ).isoformat()
    elif isinstance(quote_timestamp, str) and len(quote_timestamp) <= 100:
        payload["quote_updated_at"] = quote_timestamp
    if definition.alert_type == "news":
        headline = quote.get("headline")
        if isinstance(headline, str) and headline.strip():
            payload["headline"] = headline.strip()[:500]
    if definition.alert_type == "earnings":
        earnings_date = quote.get("earnings_date")
        if isinstance(earnings_date, (str, datetime)):
            payload["earnings_date"] = (
                earnings_date.isoformat() if isinstance(earnings_date, datetime) else earnings_date[:100]
            )
    return payload


def _evaluation(
    definition: AlertDefinition,
    *,
    matched: bool,
    reason: str,
    observed_value: Decimal | None,
    previous_value: Decimal | None,
    quote: Mapping[str, Any],
    evaluated_at: datetime,
) -> AlertEvaluation:
    return AlertEvaluation(
        matched=matched,
        reason=reason,
        evaluated_at=evaluated_at,
        observed_value=observed_value,
        previous_value=previous_value,
        payload=_event_payload(
            definition,
            observed_value=observed_value,
            previous_value=previous_value,
            quote=quote,
            evaluated_at=evaluated_at,
        ),
    )


def _definition_for_evaluation(value: Alert | AlertDefinition | Mapping[str, Any]) -> AlertDefinition:
    if isinstance(value, AlertDefinition):
        return value
    if isinstance(value, Alert):
        return normalize_alert_definition(_definition_from_alert(value))
    return normalize_alert_definition(value)


def _state_datetime(value: Alert | Mapping[str, Any], field: str) -> datetime | None:
    raw = getattr(value, field, None) if isinstance(value, Alert) else value.get(field)
    if raw is None:
        return None
    try:
        return _normalize_datetime(raw, field=field)
    except AlertServiceValidationError:
        return None


def evaluate_alert(
    alert: Alert | AlertDefinition | Mapping[str, Any],
    quote: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> AlertEvaluation:
    """Evaluate one rule with supplied values only; it performs no I/O.

    Expected quote fields are ``price``/``previous_price`` for price and
    support-resistance rules, ``iv``/``previous_iv`` for IV, ``news_match``
    for news, and ``days_until_earnings`` or ``earnings_reported`` for
    earnings.  A missing or malformed observation returns a non-matching
    result instead of fabricating market data.
    """

    if not isinstance(quote, Mapping):
        raise AlertServiceValidationError("quote must be an object")
    definition = _definition_for_evaluation(alert)
    evaluated_at = _normalize_datetime(now or datetime.now(timezone.utc), field="now")
    assert evaluated_at is not None
    if not definition.is_enabled:
        return _evaluation(
            definition,
            matched=False,
            reason="disabled",
            observed_value=None,
            previous_value=None,
            quote=quote,
            evaluated_at=evaluated_at,
        )
    if definition.expires_at is not None and definition.expires_at <= evaluated_at:
        return _evaluation(
            definition,
            matched=False,
            reason="expired",
            observed_value=None,
            previous_value=None,
            quote=quote,
            evaluated_at=evaluated_at,
        )
    last_triggered_at = _state_datetime(alert, "last_triggered_at")
    if (
        last_triggered_at is not None
        and last_triggered_at + timedelta(seconds=definition.cooldown_seconds) > evaluated_at
    ):
        return _evaluation(
            definition,
            matched=False,
            reason="cooldown",
            observed_value=None,
            previous_value=None,
            quote=quote,
            evaluated_at=evaluated_at,
        )

    if definition.alert_type in {"price", "support_resistance"}:
        observed = _quote_decimal(quote, "price")
        previous = _quote_decimal(quote, "previous_price")
    elif definition.alert_type == "iv":
        observed = _quote_decimal(quote, "iv")
        previous = _quote_decimal(quote, "previous_iv")
    else:
        observed = None
        previous = None

    if definition.alert_type in {"price", "iv"}:
        if observed is None:
            return _evaluation(
                definition,
                matched=False,
                reason=f"missing_{'price' if definition.alert_type == 'price' else 'iv'}",
                observed_value=None,
                previous_value=previous,
                quote=quote,
                evaluated_at=evaluated_at,
            )
        assert definition.target_value is not None
        target = definition.target_value
        if definition.condition == "above":
            matched, reason = observed >= target, "at_or_above_target"
        elif definition.condition == "below":
            matched, reason = observed <= target, "at_or_below_target"
        elif definition.condition == "crosses_above":
            matched = previous is not None and previous < target <= observed
            reason = "crossed_above_target"
        else:  # crosses_below
            matched = previous is not None and previous > target >= observed
            reason = "crossed_below_target"
        return _evaluation(
            definition,
            matched=matched,
            reason=reason if matched else f"not_{reason}",
            observed_value=observed,
            previous_value=previous,
            quote=quote,
            evaluated_at=evaluated_at,
        )

    if definition.alert_type == "support_resistance":
        if observed is None:
            return _evaluation(
                definition,
                matched=False,
                reason="missing_price",
                observed_value=None,
                previous_value=previous,
                quote=quote,
                evaluated_at=evaluated_at,
            )
        assert definition.target_value is not None
        target = definition.target_value
        if definition.condition == "breakout":
            matched = observed >= target and (previous is None or previous < target)
            reason = "broke_out_above_level"
        elif definition.condition == "breakdown":
            matched = observed <= target and (previous is None or previous > target)
            reason = "broke_down_below_level"
        else:  # bounce
            raw_tolerance = definition.config_json.get("tolerance_percent", DEFAULT_BOUNCE_TOLERANCE)
            tolerance = _as_decimal(raw_tolerance, field="config.tolerance_percent")
            assert tolerance is not None
            recovery_level = target * (Decimal("1") + tolerance)
            matched = observed >= recovery_level and (previous is None or previous <= recovery_level)
            reason = "bounced_from_level"
        return _evaluation(
            definition,
            matched=matched,
            reason=reason if matched else f"not_{reason}",
            observed_value=observed,
            previous_value=previous,
            quote=quote,
            evaluated_at=evaluated_at,
        )

    if definition.alert_type == "news":
        matched_flag = _quote_flag(quote, "news_match", "news_matched")
        matched = matched_flag is True
        return _evaluation(
            definition,
            matched=matched,
            reason="news_matched" if matched else "no_matching_news",
            observed_value=None,
            previous_value=None,
            quote=quote,
            evaluated_at=evaluated_at,
        )

    # The only remaining type is earnings, constrained during normalization.
    if definition.condition == "reported":
        reported = _quote_flag(quote, "earnings_reported")
        return _evaluation(
            definition,
            matched=reported is True,
            reason="earnings_reported" if reported is True else "earnings_not_reported",
            observed_value=None,
            previous_value=None,
            quote=quote,
            evaluated_at=evaluated_at,
        )
    observed = _quote_decimal(quote, "days_until_earnings")
    if observed is None:
        return _evaluation(
            definition,
            matched=False,
            reason="missing_days_until_earnings",
            observed_value=None,
            previous_value=None,
            quote=quote,
            evaluated_at=evaluated_at,
        )
    assert definition.target_value is not None
    matched = Decimal("0") <= observed <= definition.target_value
    return _evaluation(
        definition,
        matched=matched,
        reason="earnings_within_window" if matched else "earnings_outside_window",
        observed_value=observed,
        previous_value=None,
        quote=quote,
        evaluated_at=evaluated_at,
    )


def _alert_event_title(alert: Alert, evaluation: AlertEvaluation) -> str:
    subject = alert.ticker or "Market"
    if alert.alert_type == "price":
        return f"{subject} price alert"
    if alert.alert_type == "support_resistance":
        return f"{subject} support/resistance alert"
    if alert.alert_type == "iv":
        return f"{subject} IV alert"
    if alert.alert_type == "news":
        return f"{subject} news alert"
    return f"{subject} earnings alert"


def _record_alert_trigger(
    session: Session,
    *,
    profile_id: uuid.UUID,
    alert_id: int,
    evaluation: AlertEvaluation,
    dedupe_key: str | None = None,
    delivery_status: str = "in_app",
) -> tuple[NotificationEvent, bool]:
    """Persist a matched evaluation and its inbox event atomically enough for a worker.

    The caller must only pass a result produced for the same alert.  This
    helper checks ownership, enforces the event's optional dedupe key, updates
    trigger state, and creates no network side effect.
    """

    if not isinstance(evaluation, AlertEvaluation):
        raise AlertServiceValidationError("evaluation must be an AlertEvaluation")
    if not evaluation.matched:
        raise AlertServiceValidationError("only matched evaluations can create notification events")
    alert = get_alert_for_profile(
        session, profile_id=profile_id, alert_id=alert_id, for_update=True
    )
    dedupe_key = _normalize_dedupe_key(dedupe_key)
    existing = _existing_deduped_event(session, profile_id=profile_id, dedupe_key=dedupe_key)
    if existing is not None:
        return existing, False
    if not alert.is_enabled:
        raise AlertServiceValidationError("disabled alerts cannot create notification events")
    if alert.expires_at is not None and alert.expires_at <= evaluation.evaluated_at:
        raise AlertServiceValidationError("expired alerts cannot create notification events")
    if (
        alert.last_triggered_at is not None
        and alert.last_triggered_at + timedelta(seconds=alert.cooldown_seconds) > evaluation.evaluated_at
    ):
        raise AlertServiceValidationError("alert cooldown is active")
    if evaluation.payload.get("alert_type") != alert.alert_type:
        raise AlertServiceValidationError("evaluation does not match the alert type")
    if evaluation.payload.get("ticker") != alert.ticker:
        raise AlertServiceValidationError("evaluation does not match the alert ticker")
    if evaluation.payload.get("condition") != alert.condition:
        raise AlertServiceValidationError("evaluation does not match the alert condition")
    evaluation_target = evaluation.payload.get("target_value")
    if alert.target_value is None:
        target_matches = evaluation_target is None
    else:
        try:
            target_matches = _as_decimal(evaluation_target, field="evaluation.target_value") == alert.target_value
        except AlertServiceValidationError:
            target_matches = False
    if not target_matches:
        raise AlertServiceValidationError("evaluation does not match the alert target")

    body = evaluation.reason.replace("_", " ")
    event, created = _record_notification_event(
        session,
        profile_id=profile_id,
        alert_id=int(alert.id),
        notification_type=alert.alert_type,
        title=_alert_event_title(alert, evaluation),
        body=body,
        ticker=alert.ticker,
        severity="info",
        payload=evaluation.payload,
        delivery_status=delivery_status,
        dedupe_key=dedupe_key,
    )
    # Only a newly inserted event advances alert state.  This avoids a second
    # worker incrementing ``trigger_count`` when it loses a dedupe-key race.
    if created:
        alert.last_evaluated_at = evaluation.evaluated_at
        alert.last_triggered_at = evaluation.evaluated_at
        alert.trigger_count += 1
        session.flush()
    return event, created


def record_alert_trigger(
    session: Session,
    *,
    profile_id: uuid.UUID,
    alert_id: int,
    evaluation: AlertEvaluation,
    dedupe_key: str | None = None,
    delivery_status: str = "in_app",
) -> NotificationEvent:
    """Persist a matched evaluation as a durable notification inbox event."""

    event, _created = _record_alert_trigger(
        session,
        profile_id=profile_id,
        alert_id=alert_id,
        evaluation=evaluation,
        dedupe_key=dedupe_key,
        delivery_status=delivery_status,
    )
    return event


def evaluate_price_alerts(
    session: Session,
    ticker: str,
    price: Any,
    observed_at: datetime | None = None,
    *,
    previous_price: Any | None = None,
) -> list[NotificationEvent]:
    """Evaluate enabled price/S&R rules for one ticker and append new inbox events.

    This is deliberately an internal worker-facing helper, not an HTTP
    endpoint.  It performs no quote fetch: the caller supplies a validated
    observation (and may optionally provide the previous price for crossing
    conditions).  Row locks plus a deterministic per-observation dedupe key
    make repeat delivery from two quote consumers safe.  The caller owns the
    transaction and should commit it before any external notification delivery.
    """

    normalized_ticker = normalize_alert_ticker(ticker, required=True)
    assert normalized_ticker is not None
    observed_value = _require_nonnegative(_as_decimal(price, field="price"), field="price")
    timestamp = _normalize_datetime(
        observed_at or datetime.now(timezone.utc), field="observed_at"
    )
    assert timestamp is not None
    quote: dict[str, Any] = {"price": observed_value, "updated_at": timestamp}
    if previous_price is not None:
        quote["previous_price"] = _require_nonnegative(
            _as_decimal(previous_price, field="previous_price"), field="previous_price"
        )

    # This helper is for a trusted backend quote pipeline.  It intentionally
    # spans profiles so one market observation can efficiently service every
    # subscribed user; the public CRUD functions remain profile-scoped.
    statement = (
        select(Alert)
        .where(
            Alert.ticker == normalized_ticker,
            Alert.alert_type.in_(("price", "support_resistance")),
            Alert.is_enabled.is_(True),
            (Alert.expires_at.is_(None) | (Alert.expires_at > timestamp)),
        )
        .with_for_update()
    )
    created_events: list[NotificationEvent] = []
    for alert in session.scalars(statement):
        evaluation = evaluate_alert(alert, quote, now=timestamp)
        # Evaluation cadence is durable even when no event should be emitted.
        alert.last_evaluated_at = timestamp
        if not evaluation.matched:
            continue
        dedupe_key = f"alert:{int(alert.id)}:price:{timestamp.isoformat()}"
        event, created = _record_alert_trigger(
            session,
            profile_id=alert.profile_id,
            alert_id=int(alert.id),
            evaluation=evaluation,
            dedupe_key=dedupe_key,
            delivery_status="in_app",
        )
        if created:
            created_events.append(event)
    session.flush()
    return created_events
