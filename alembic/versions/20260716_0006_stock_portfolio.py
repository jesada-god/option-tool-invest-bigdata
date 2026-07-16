"""Add durable stock holdings and trade history to cloud portfolios.

Revision ID: 20260716_0006
Revises: 20260716_0005
Create Date: 2026-07-16 13:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260716_0006"
down_revision: Union[str, Sequence[str], None] = "20260716_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "stock_holdings",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("portfolio_id", sa.BigInteger(), sa.ForeignKey("portfolios.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ticker", sa.String(length=12), nullable=False),
        sa.Column("shares", sa.Numeric(24, 8), nullable=False),
        sa.Column("average_cost", sa.Numeric(24, 8), nullable=False),
        sa.Column("realized_pnl", sa.Numeric(24, 8), nullable=False, server_default="0"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("portfolio_id", "ticker", name="uq_stock_holdings_portfolio_ticker"),
        sa.CheckConstraint("ticker = upper(ticker)", name="ck_stock_holdings_ticker_upper"),
        sa.CheckConstraint("char_length(ticker) BETWEEN 1 AND 12", name="ck_stock_holdings_ticker_length"),
        sa.CheckConstraint("shares >= 0", name="ck_stock_holdings_shares_nonnegative"),
        sa.CheckConstraint("average_cost >= 0", name="ck_stock_holdings_average_cost_nonnegative"),
    )
    op.create_index("ix_stock_holdings_portfolio_ticker", "stock_holdings", ["portfolio_id", "ticker"])
    op.create_table(
        "stock_transactions",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("holding_id", sa.BigInteger(), sa.ForeignKey("stock_holdings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("side", sa.String(length=4), nullable=False),
        sa.Column("shares", sa.Numeric(24, 8), nullable=False),
        sa.Column("price", sa.Numeric(24, 8), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("traded_at", sa.Date(), nullable=False, server_default=sa.text("CURRENT_DATE")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("side IN ('BUY', 'SELL')", name="ck_stock_transactions_side"),
        sa.CheckConstraint("shares > 0", name="ck_stock_transactions_shares_positive"),
        sa.CheckConstraint("price >= 0", name="ck_stock_transactions_price_nonnegative"),
    )
    op.create_index("ix_stock_transactions_holding_traded", "stock_transactions", ["holding_id", "traded_at"])


def downgrade() -> None:
    op.drop_index("ix_stock_transactions_holding_traded", table_name="stock_transactions")
    op.drop_table("stock_transactions")
    op.drop_index("ix_stock_holdings_portfolio_ticker", table_name="stock_holdings")
    op.drop_table("stock_holdings")
