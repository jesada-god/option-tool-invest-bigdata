"""Add cloud-synced favorites, activity, and simulator history.

Revision ID: 20260716_0003
Revises: 20260715_0002
Create Date: 2026-07-16 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "20260716_0003"
down_revision: Union[str, Sequence[str], None] = "20260715_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "favorites",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_favorites_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_favorites_ticker_length"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "ticker", name="uq_favorites_profile_ticker"),
    )
    op.create_index("ix_favorites_profile_created", "favorites", ["profile_id", "created_at"], unique=False)

    op.create_table(
        "search_history",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=False),
        sa.Column("query", sa.String(length=120), nullable=False),
        sa.Column("search_count", sa.Integer(), server_default="1", nullable=False),
        sa.Column("last_searched_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_search_history_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_search_history_ticker_length"),
        sa.CheckConstraint("char_length(query) BETWEEN 1 AND 120", name="ck_search_history_query_length"),
        sa.CheckConstraint("search_count >= 1", name="ck_search_history_count"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "ticker", name="uq_search_history_profile_ticker"),
    )
    op.create_index("ix_search_history_profile_recent", "search_history", ["profile_id", "last_searched_at"], unique=False)

    op.create_table(
        "recent_viewed",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=False),
        sa.Column("view_count", sa.Integer(), server_default="1", nullable=False),
        sa.Column("last_viewed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_recent_viewed_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_recent_viewed_ticker_length"),
        sa.CheckConstraint("view_count >= 1", name="ck_recent_viewed_count"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "ticker", name="uq_recent_viewed_profile_ticker"),
    )
    op.create_index("ix_recent_viewed_profile_recent", "recent_viewed", ["profile_id", "last_viewed_at"], unique=False)

    op.create_table(
        "simulation_history",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=False),
        sa.Column("simulation_type", sa.String(length=32), nullable=False),
        sa.Column("input", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_simulation_history_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_simulation_history_ticker_length"),
        sa.CheckConstraint("char_length(simulation_type) BETWEEN 1 AND 32", name="ck_simulation_history_type_length"),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_simulation_history_profile_created", "simulation_history", ["profile_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_simulation_history_profile_created", table_name="simulation_history")
    op.drop_table("simulation_history")
    op.drop_index("ix_recent_viewed_profile_recent", table_name="recent_viewed")
    op.drop_table("recent_viewed")
    op.drop_index("ix_search_history_profile_recent", table_name="search_history")
    op.drop_table("search_history")
    op.drop_index("ix_favorites_profile_created", table_name="favorites")
    op.drop_table("favorites")
