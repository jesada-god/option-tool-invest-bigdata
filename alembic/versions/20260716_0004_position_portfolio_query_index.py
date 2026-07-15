"""Add an index for the authenticated open-option wallet query.

Revision ID: 20260716_0004
Revises: 20260716_0003
Create Date: 2026-07-16 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op


revision: str = "20260716_0004"
down_revision: Union[str, Sequence[str], None] = "20260716_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_positions_portfolio_option_opened",
        "positions",
        ["portfolio_id", "asset_type", "is_open", "opened_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_positions_portfolio_option_opened", table_name="positions")
