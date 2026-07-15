"""SQLAlchemy 2.0 persistence schema for cloud-synced user data.

The profile primary key intentionally matches the UUID subject issued by the
chosen auth provider (for example Supabase Auth).  A foreign key to
``auth.users`` is not declared here because managed Supabase projects often do
not grant application migrations permission to alter the ``auth`` schema.
The future auth boundary must verify the subject before opening a user session.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


JSONValue = JSON().with_variant(JSONB, "postgresql")


class Base(DeclarativeBase):
    """Base class used by Alembic and all persistence entities."""


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class Profile(TimestampMixin, Base):
    __tablename__ = "profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    username: Mapped[str] = mapped_column(String(32), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(2_048), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # ``NULL`` means the auth provider created a provisional profile but the
    # user has not finished the first-time username setup flow yet.
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    preferences: Mapped["UserPreference | None"] = relationship(
        back_populates="profile", cascade="all, delete-orphan", uselist=False
    )
    portfolios: Mapped[list["Portfolio"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )
    watchlists: Mapped[list["Watchlist"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )
    alerts: Mapped[list["Alert"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )
    notification_events: Mapped[list["NotificationEvent"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("email", name="uq_profiles_email"),
        UniqueConstraint("username", name="uq_profiles_username"),
        CheckConstraint("char_length(username) BETWEEN 3 AND 32", name="ck_profiles_username_length"),
        CheckConstraint("username = btrim(username)", name="ck_profiles_username_trimmed"),
    )


class UserPreference(TimestampMixin, Base):
    __tablename__ = "user_preferences"

    profile_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    theme: Mapped[str] = mapped_column(String(16), nullable=False, default="dark", server_default="dark")
    language: Mapped[str] = mapped_column(String(12), nullable=False, default="en", server_default="en")
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONValue, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    profile: Mapped[Profile] = relationship(back_populates="preferences")

    __table_args__ = (
        CheckConstraint("theme IN ('dark', 'light', 'system')", name="ck_preferences_theme"),
        CheckConstraint("char_length(language) BETWEEN 2 AND 12", name="ck_preferences_language_length"),
    )


class Portfolio(TimestampMixin, Base):
    __tablename__ = "portfolios"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD", server_default="USD")
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    profile: Mapped[Profile] = relationship(back_populates="portfolios")
    positions: Mapped[list["Position"]] = relationship(
        back_populates="portfolio", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("profile_id", "name", name="uq_portfolios_profile_name"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="ck_portfolios_name_length"),
        CheckConstraint("currency = upper(currency)", name="ck_portfolios_currency_upper"),
        Index("ix_portfolios_profile_sort", "profile_id", "sort_order"),
        Index(
            "uq_portfolios_one_default_per_profile",
            "profile_id",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )


class Watchlist(TimestampMixin, Base):
    __tablename__ = "watchlists"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    is_favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    profile: Mapped[Profile] = relationship(back_populates="watchlists")
    items: Mapped[list["WatchlistItem"]] = relationship(
        back_populates="watchlist", cascade="all, delete-orphan", order_by="WatchlistItem.sort_order"
    )

    __table_args__ = (
        UniqueConstraint("profile_id", "name", name="uq_watchlists_profile_name"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="ck_watchlists_name_length"),
        Index("ix_watchlists_profile_sort", "profile_id", "is_pinned", "sort_order"),
        Index(
            "uq_watchlists_one_default_per_profile",
            "profile_id",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    watchlist_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False
    )
    ticker: Mapped[str] = mapped_column(String(12), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    watchlist: Mapped[Watchlist] = relationship(back_populates="items")

    __table_args__ = (
        UniqueConstraint("watchlist_id", "ticker", name="uq_watchlist_items_watchlist_ticker"),
        CheckConstraint("ticker = upper(ticker)", name="ck_watchlist_items_ticker_upper"),
        CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_watchlist_items_ticker_length"),
        Index("ix_watchlist_items_watchlist_sort", "watchlist_id", "sort_order"),
    )


class Position(TimestampMixin, Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("portfolios.id", ondelete="CASCADE"), nullable=False
    )
    # An option contract symbol can be longer than its 1-12 character
    # underlying ticker (for example an OCC-style symbol), so positions have a
    # wider identifier than watchlist entries.
    ticker: Mapped[str] = mapped_column(String(32), nullable=False)
    asset_type: Mapped[str] = mapped_column(String(16), nullable=False, default="stock", server_default="stock")
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8), nullable=False)
    average_cost: Mapped[Decimal] = mapped_column(Numeric(24, 8), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD", server_default="USD")
    underlying_ticker: Mapped[str | None] = mapped_column(String(12), nullable=True)
    strike_price: Mapped[Decimal | None] = mapped_column(Numeric(24, 8), nullable=True)
    option_type: Mapped[str | None] = mapped_column(String(4), nullable=True)
    expiration: Mapped[date | None] = mapped_column(Date, nullable=True)
    opened_at: Mapped[date] = mapped_column(Date, nullable=False, server_default=func.current_date())
    closed_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    is_open: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    metadata_json: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONValue, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    portfolio: Mapped[Portfolio] = relationship(back_populates="positions")

    __table_args__ = (
        CheckConstraint("ticker = upper(ticker)", name="ck_positions_ticker_upper"),
        CheckConstraint("char_length(ticker) BETWEEN 1 AND 32", name="ck_positions_ticker_length"),
        CheckConstraint("quantity <> 0", name="ck_positions_quantity_nonzero"),
        CheckConstraint("average_cost >= 0", name="ck_positions_average_cost_nonnegative"),
        CheckConstraint("currency = upper(currency)", name="ck_positions_currency_upper"),
        CheckConstraint(
            "option_type IS NULL OR lower(option_type) IN ('call', 'put')",
            name="ck_positions_option_type",
        ),
        CheckConstraint(
            "strike_price IS NULL OR strike_price >= 0", name="ck_positions_strike_price_nonnegative"
        ),
        Index("ix_positions_portfolio_open", "portfolio_id", "is_open"),
        Index("ix_positions_ticker", "ticker"),
        Index("ix_positions_underlying_ticker", "underlying_ticker"),
    )


class Alert(TimestampMixin, Base):
    """A durable, user-owned rule that can produce notification events.

    The evaluator intentionally remains outside the ORM model: workers and
    request handlers can supply their own quote/news/earnings observations
    without making a database object responsible for network I/O.
    """

    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    alert_type: Mapped[str] = mapped_column(String(32), nullable=False)
    condition: Mapped[str] = mapped_column(String(32), nullable=False)
    ticker: Mapped[str | None] = mapped_column(String(12), nullable=True)
    target_value: Mapped[Decimal | None] = mapped_column(Numeric(24, 8), nullable=True)
    config_json: Mapped[dict[str, Any]] = mapped_column(
        "config", JSONValue, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    delivery_channels: Mapped[list[str]] = mapped_column(
        JSONValue, nullable=False, default=lambda: ["in_app"], server_default=text("'[\"in_app\"]'::jsonb")
    )
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    cooldown_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=300, server_default="300"
    )
    trigger_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    profile: Mapped[Profile] = relationship(back_populates="alerts")
    events: Mapped[list["NotificationEvent"]] = relationship(
        back_populates="alert", passive_deletes=True
    )

    __table_args__ = (
        CheckConstraint(
            "alert_type IN ('price', 'support_resistance', 'iv', 'news', 'earnings')",
            name="ck_alerts_type",
        ),
        CheckConstraint(
            "condition IN ("
            "'above', 'below', 'crosses_above', 'crosses_below', "
            "'breakout', 'breakdown', 'bounce', 'matched', 'within_days', 'reported'"
            ")",
            name="ck_alerts_condition",
        ),
        CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="ck_alerts_name_length"),
        CheckConstraint("name = btrim(name)", name="ck_alerts_name_trimmed"),
        CheckConstraint(
            "ticker IS NULL OR (ticker = upper(ticker) AND char_length(ticker) BETWEEN 1 AND 12)",
            name="ck_alerts_ticker",
        ),
        CheckConstraint(
            "target_value IS NULL OR target_value >= 0", name="ck_alerts_target_nonnegative"
        ),
        CheckConstraint(
            "cooldown_seconds BETWEEN 0 AND 604800", name="ck_alerts_cooldown_range"
        ),
        CheckConstraint("trigger_count >= 0", name="ck_alerts_trigger_count_nonnegative"),
        Index("ix_alerts_profile_enabled", "profile_id", "is_enabled"),
        Index("ix_alerts_profile_ticker", "profile_id", "ticker"),
        Index("ix_alerts_next_evaluation", "is_enabled", "last_evaluated_at"),
    )


class NotificationEvent(Base):
    """Immutable-ish user notification inbox row produced by an alert worker.

    Alert deletion deliberately retains historical events by setting
    ``alert_id`` to ``NULL``.  Profile deletion remains a cascade so one user
    can never retain another user's notification history.
    """

    __tablename__ = "notification_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    alert_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("alerts.id", ondelete="SET NULL"), nullable=True
    )
    notification_type: Mapped[str] = mapped_column(String(32), nullable=False)
    severity: Mapped[str] = mapped_column(
        String(16), nullable=False, default="info", server_default="info"
    )
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    ticker: Mapped[str | None] = mapped_column(String(12), nullable=True)
    payload_json: Mapped[dict[str, Any]] = mapped_column(
        "payload", JSONValue, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    delivery_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="in_app", server_default="in_app"
    )
    dedupe_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivery_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    profile: Mapped[Profile] = relationship(back_populates="notification_events")
    alert: Mapped[Alert | None] = relationship(back_populates="events")

    __table_args__ = (
        CheckConstraint(
            "notification_type IN ('price', 'support_resistance', 'iv', 'news', 'earnings', 'system')",
            name="ck_notification_events_type",
        ),
        CheckConstraint(
            "severity IN ('info', 'success', 'warning', 'critical')",
            name="ck_notification_events_severity",
        ),
        CheckConstraint(
            "delivery_status IN ('in_app', 'pending', 'delivered', 'failed')",
            name="ck_notification_events_delivery_status",
        ),
        CheckConstraint("char_length(title) BETWEEN 1 AND 160", name="ck_notification_events_title_length"),
        CheckConstraint(
            "ticker IS NULL OR (ticker = upper(ticker) AND char_length(ticker) BETWEEN 1 AND 12)",
            name="ck_notification_events_ticker",
        ),
        Index("ix_notification_events_profile_created", "profile_id", "created_at"),
        Index("ix_notification_events_profile_unread", "profile_id", "read_at", "created_at"),
        Index(
            "uq_notification_events_profile_dedupe",
            "profile_id",
            "dedupe_key",
            unique=True,
            postgresql_where=text("dedupe_key IS NOT NULL"),
        ),
    )
