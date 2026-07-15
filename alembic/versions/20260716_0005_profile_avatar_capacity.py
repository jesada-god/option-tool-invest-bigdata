"""Allow compact, cropped profile image data URLs.

Revision ID: 20260716_0005
Revises: 20260716_0004
Create Date: 2026-07-16 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260716_0005"
down_revision: Union[str, Sequence[str], None] = "20260716_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("profiles", "avatar_url", existing_type=sa.String(length=2048), type_=sa.String(length=262144))


def downgrade() -> None:
    op.alter_column("profiles", "avatar_url", existing_type=sa.String(length=262144), type_=sa.String(length=2048))
