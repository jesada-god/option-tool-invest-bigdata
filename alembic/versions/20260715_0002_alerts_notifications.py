"""Add durable user-owned alerts and notification events.

Revision ID: 20260715_0002
Revises: 20260715_0001
Create Date: 2026-07-15 00:10:00.000000

The rows are intentionally provider-agnostic.  A future worker can evaluate
an alert with a licensed market-data feed, then write a ``notification_events``
row without holding a browser connection open.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260715_0002"
down_revision: Union[str, Sequence[str], None] = "20260715_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "alerts",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("alert_type", sa.String(length=32), nullable=False),
        sa.Column("condition", sa.String(length=32), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=True),
        sa.Column("target_value", sa.Numeric(precision=24, scale=8), nullable=True),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "delivery_channels",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[\"in_app\"]'::jsonb"),
            nullable=False,
        ),
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("cooldown_seconds", sa.Integer(), server_default="300", nullable=False),
        sa.Column("trigger_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_triggered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "alert_type IN ('price', 'support_resistance', 'iv', 'news', 'earnings')",
            name="ck_alerts_type",
        ),
        sa.CheckConstraint(
            "condition IN ("
            "'above', 'below', 'crosses_above', 'crosses_below', "
            "'breakout', 'breakdown', 'bounce', 'matched', 'within_days', 'reported'"
            ")",
            name="ck_alerts_condition",
        ),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="ck_alerts_name_length"),
        sa.CheckConstraint("name = btrim(name)", name="ck_alerts_name_trimmed"),
        sa.CheckConstraint(
            "ticker IS NULL OR (ticker = upper(ticker) AND char_length(ticker) BETWEEN 1 AND 12)",
            name="ck_alerts_ticker",
        ),
        sa.CheckConstraint(
            "target_value IS NULL OR target_value >= 0", name="ck_alerts_target_nonnegative"
        ),
        sa.CheckConstraint(
            "cooldown_seconds BETWEEN 0 AND 604800", name="ck_alerts_cooldown_range"
        ),
        sa.CheckConstraint("trigger_count >= 0", name="ck_alerts_trigger_count_nonnegative"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_alerts_profile_enabled", "alerts", ["profile_id", "is_enabled"], unique=False)
    op.create_index("ix_alerts_profile_ticker", "alerts", ["profile_id", "ticker"], unique=False)
    op.create_index("ix_alerts_next_evaluation", "alerts", ["is_enabled", "last_evaluated_at"], unique=False)

    op.create_table(
        "notification_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("alert_id", sa.BigInteger(), nullable=True),
        sa.Column("notification_type", sa.String(length=32), nullable=False),
        sa.Column("severity", sa.String(length=16), server_default="info", nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("ticker", sa.String(length=12), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("delivery_status", sa.String(length=16), server_default="in_app", nullable=False),
        sa.Column("dedupe_key", sa.String(length=160), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivery_error", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "notification_type IN ('price', 'support_resistance', 'iv', 'news', 'earnings', 'system')",
            name="ck_notification_events_type",
        ),
        sa.CheckConstraint(
            "severity IN ('info', 'success', 'warning', 'critical')",
            name="ck_notification_events_severity",
        ),
        sa.CheckConstraint(
            "delivery_status IN ('in_app', 'pending', 'delivered', 'failed')",
            name="ck_notification_events_delivery_status",
        ),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 160", name="ck_notification_events_title_length"),
        sa.CheckConstraint(
            "ticker IS NULL OR (ticker = upper(ticker) AND char_length(ticker) BETWEEN 1 AND 12)",
            name="ck_notification_events_ticker",
        ),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notification_events_profile_created",
        "notification_events",
        ["profile_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_notification_events_profile_unread",
        "notification_events",
        ["profile_id", "read_at", "created_at"],
        unique=False,
    )
    op.create_index(
        "uq_notification_events_profile_dedupe",
        "notification_events",
        ["profile_id", "dedupe_key"],
        unique=True,
        postgresql_where=sa.text("dedupe_key IS NOT NULL"),
    )

    # The initial persistence migration installs this shared trigger function.
    op.execute(
        """
        CREATE TRIGGER trg_alerts_touch_updated_at
        BEFORE UPDATE ON alerts
        FOR EACH ROW EXECUTE FUNCTION portfolio_terminal_touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_alerts_touch_updated_at ON alerts")
    op.drop_index("uq_notification_events_profile_dedupe", table_name="notification_events")
    op.drop_index("ix_notification_events_profile_unread", table_name="notification_events")
    op.drop_index("ix_notification_events_profile_created", table_name="notification_events")
    op.drop_table("notification_events")
    op.drop_index("ix_alerts_next_evaluation", table_name="alerts")
    op.drop_index("ix_alerts_profile_ticker", table_name="alerts")
    op.drop_index("ix_alerts_profile_enabled", table_name="alerts")
    op.drop_table("alerts")
