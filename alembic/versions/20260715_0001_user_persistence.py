"""Initial user-scoped persistence foundation.

Revision ID: 20260715_0001
Revises:
Create Date: 2026-07-15 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260715_0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("username", sa.String(length=32), nullable=False),
        sa.Column("avatar_url", sa.String(length=2048), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("onboarding_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("char_length(username) BETWEEN 3 AND 32", name="ck_profiles_username_length"),
        sa.CheckConstraint("username = btrim(username)", name="ck_profiles_username_trimmed"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email", name="uq_profiles_email"),
        sa.UniqueConstraint("username", name="uq_profiles_username"),
    )
    op.create_table(
        "user_preferences",
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("theme", sa.String(length=16), server_default="dark", nullable=False),
        sa.Column("language", sa.String(length=12), server_default="en", nullable=False),
        sa.Column("settings", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("theme IN ('dark', 'light', 'system')", name="ck_preferences_theme"),
        sa.CheckConstraint("char_length(language) BETWEEN 2 AND 12", name="ck_preferences_language_length"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("profile_id"),
    )
    op.create_table(
        "portfolios",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="ck_portfolios_name_length"),
        sa.CheckConstraint("currency = upper(currency)", name="ck_portfolios_currency_upper"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "name", name="uq_portfolios_profile_name"),
    )
    op.create_index("ix_portfolios_profile_sort", "portfolios", ["profile_id", "sort_order"], unique=False)
    op.create_index(
        "uq_portfolios_one_default_per_profile",
        "portfolios",
        ["profile_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    op.create_table(
        "watchlists",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_favorite", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="ck_watchlists_name_length"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "name", name="uq_watchlists_profile_name"),
    )
    op.create_index(
        "ix_watchlists_profile_sort",
        "watchlists",
        ["profile_id", "is_pinned", "sort_order"],
        unique=False,
    )
    op.create_index(
        "uq_watchlists_one_default_per_profile",
        "watchlists",
        ["profile_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("watchlist_id", sa.BigInteger(), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_watchlist_items_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_watchlist_items_ticker_length"),
        sa.ForeignKeyConstraint(["watchlist_id"], ["watchlists.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("watchlist_id", "ticker", name="uq_watchlist_items_watchlist_ticker"),
    )
    op.create_index(
        "ix_watchlist_items_watchlist_sort",
        "watchlist_items",
        ["watchlist_id", "sort_order"],
        unique=False,
    )
    op.create_table(
        "positions",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("portfolio_id", sa.BigInteger(), nullable=False),
        sa.Column("ticker", sa.String(length=32), nullable=False),
        sa.Column("asset_type", sa.String(length=16), server_default="stock", nullable=False),
        sa.Column("quantity", sa.Numeric(precision=24, scale=8), nullable=False),
        sa.Column("average_cost", sa.Numeric(precision=24, scale=8), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("underlying_ticker", sa.String(length=12), nullable=True),
        sa.Column("strike_price", sa.Numeric(precision=24, scale=8), nullable=True),
        sa.Column("option_type", sa.String(length=4), nullable=True),
        sa.Column("expiration", sa.Date(), nullable=True),
        sa.Column("opened_at", sa.Date(), server_default=sa.text("CURRENT_DATE"), nullable=False),
        sa.Column("closed_at", sa.Date(), nullable=True),
        sa.Column("is_open", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_positions_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 32", name="ck_positions_ticker_length"),
        sa.CheckConstraint("quantity <> 0", name="ck_positions_quantity_nonzero"),
        sa.CheckConstraint("average_cost >= 0", name="ck_positions_average_cost_nonnegative"),
        sa.CheckConstraint("currency = upper(currency)", name="ck_positions_currency_upper"),
        sa.CheckConstraint("option_type IS NULL OR lower(option_type) IN ('call', 'put')", name="ck_positions_option_type"),
        sa.CheckConstraint("strike_price IS NULL OR strike_price >= 0", name="ck_positions_strike_price_nonnegative"),
        sa.ForeignKeyConstraint(["portfolio_id"], ["portfolios.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_positions_portfolio_open", "positions", ["portfolio_id", "is_open"], unique=False)
    op.create_index("ix_positions_ticker", "positions", ["ticker"], unique=False)
    op.create_index("ix_positions_underlying_ticker", "positions", ["underlying_ticker"], unique=False)
    # Keep audit timestamps accurate even if a trusted maintenance task updates
    # a row outside the SQLAlchemy ORM.
    op.execute(
        """
        CREATE FUNCTION portfolio_terminal_touch_updated_at()
        RETURNS trigger AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    for table_name in ("profiles", "user_preferences", "portfolios", "watchlists", "positions"):
        op.execute(
            f"""
            CREATE TRIGGER trg_{table_name}_touch_updated_at
            BEFORE UPDATE ON {table_name}
            FOR EACH ROW EXECUTE FUNCTION portfolio_terminal_touch_updated_at();
            """
        )


def downgrade() -> None:
    for table_name in ("positions", "watchlists", "portfolios", "user_preferences", "profiles"):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table_name}_touch_updated_at ON {table_name}")
    op.execute("DROP FUNCTION IF EXISTS portfolio_terminal_touch_updated_at()")
    op.drop_index("ix_positions_underlying_ticker", table_name="positions")
    op.drop_index("ix_positions_ticker", table_name="positions")
    op.drop_index("ix_positions_portfolio_open", table_name="positions")
    op.drop_table("positions")
    op.drop_index("ix_watchlist_items_watchlist_sort", table_name="watchlist_items")
    op.drop_table("watchlist_items")
    op.drop_index("uq_watchlists_one_default_per_profile", table_name="watchlists")
    op.drop_index("ix_watchlists_profile_sort", table_name="watchlists")
    op.drop_table("watchlists")
    op.drop_index("uq_portfolios_one_default_per_profile", table_name="portfolios")
    op.drop_index("ix_portfolios_profile_sort", table_name="portfolios")
    op.drop_table("portfolios")
    op.drop_table("user_preferences")
    op.drop_table("profiles")
