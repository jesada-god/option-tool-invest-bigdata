"""User-scoped cloud-sync operations shared by authenticated API routes.

These functions deliberately keep the legacy response shapes at the boundary
while persisting each user's data through SQLAlchemy.  They take an existing
``Session`` so the caller owns transaction/error handling.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import (
    Portfolio, Position, Profile, StockHolding, StockTransaction,
    UserPreference, Watchlist, WatchlistItem,
)
from .repositories import PortfolioRepository, ProfileRepository, WatchlistRepository


# Keep these limits in the service layer as well as in the database schema.
# API routes call this module directly, so the checks remain in force even when
# a route is added outside Pydantic/FastAPI later.
MAX_RESOURCE_NAME_LENGTH = 80
MAX_WATCHLIST_TICKER_LENGTH = 12
MAX_STOCK_NOTES_LENGTH = 4_000
MAX_SORT_ORDER = 2_147_483_647
_WATCHLIST_TICKER_PATTERN = re.compile(
    rf"^[A-Z0-9][A-Z0-9.\-]{{0,{MAX_WATCHLIST_TICKER_LENGTH - 1}}}$"
)


class CloudServiceValidationError(ValueError):
    """The caller supplied a value that cannot be stored safely."""


class CloudResourceNotFoundError(LookupError):
    """The requested resource does not belong to the authenticated profile."""


class DefaultResourceProtectionError(CloudServiceValidationError):
    """A caller attempted to remove or archive a required default resource."""


def _normalize_resource_name(value: str, *, resource: str) -> str:
    if not isinstance(value, str):
        raise CloudServiceValidationError(f"{resource} name must be text")
    normalized = value.strip()
    if not normalized:
        raise CloudServiceValidationError(f"{resource} name is required")
    if len(normalized) > MAX_RESOURCE_NAME_LENGTH:
        raise CloudServiceValidationError(
            f"{resource} name must be at most {MAX_RESOURCE_NAME_LENGTH} characters"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise CloudServiceValidationError(f"{resource} name cannot contain control characters")
    return normalized


def normalize_portfolio_name(value: str) -> str:
    """Return a display-safe portfolio name accepted by the persistence schema."""

    return _normalize_resource_name(value, resource="portfolio")


def normalize_watchlist_name(value: str) -> str:
    """Return a display-safe watchlist name accepted by the persistence schema."""

    return _normalize_resource_name(value, resource="watchlist")


def normalize_watchlist_ticker(value: str) -> str:
    """Normalize one stock/ETF/crypto symbol for a 12-character watchlist item."""

    if not isinstance(value, str):
        raise CloudServiceValidationError("ticker must be text")
    normalized = value.strip().upper()
    if not _WATCHLIST_TICKER_PATTERN.fullmatch(normalized):
        raise CloudServiceValidationError(
            "ticker must be 1-12 uppercase letters, digits, dots, or hyphens"
        )
    return normalized


def normalize_stock_notes(value: str | None) -> str | None:
    """Keep optional holding and trade notes compact and display-safe."""

    if value is None:
        return None
    if not isinstance(value, str):
        raise CloudServiceValidationError("notes must be text")
    normalized = value.strip()
    if len(normalized) > MAX_STOCK_NOTES_LENGTH:
        raise CloudServiceValidationError(f"notes must be at most {MAX_STOCK_NOTES_LENGTH} characters")
    if any(ord(character) < 32 and character not in "\n\t" for character in normalized):
        raise CloudServiceValidationError("notes cannot contain control characters")
    return normalized or None


def normalize_portfolio_currency(value: str) -> str:
    """Validate the three-letter, uppercase currency field in ``Portfolio``."""

    if not isinstance(value, str):
        raise CloudServiceValidationError("currency must be text")
    normalized = value.strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", normalized):
        raise CloudServiceValidationError("currency must be a three-letter ISO-style code")
    return normalized


def normalize_sort_order(value: int) -> int:
    """Validate an explicit non-negative PostgreSQL ``INTEGER`` sort order."""

    if isinstance(value, bool) or not isinstance(value, int):
        raise CloudServiceValidationError("sort_order must be an integer")
    if value < 0 or value > MAX_SORT_ORDER:
        raise CloudServiceValidationError(f"sort_order must be between 0 and {MAX_SORT_ORDER}")
    return value


def _require_bool(value: bool, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise CloudServiceValidationError(f"{field} must be true or false")
    return value


def _as_utc(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if not isinstance(value, datetime):
        raise CloudServiceValidationError("archived_at must be a datetime")
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _next_portfolio_sort_order(session: Session, profile_id: uuid.UUID) -> int:
    current_max = session.scalar(
        select(func.max(Portfolio.sort_order)).where(
            Portfolio.profile_id == profile_id,
            Portfolio.archived_at.is_(None),
        )
    )
    if current_max is None:
        return 0
    if int(current_max) >= MAX_SORT_ORDER:
        raise CloudServiceValidationError("portfolio sort order limit reached")
    return int(current_max) + 1


def _portfolio_for_profile(
    session: Session, *, profile_id: uuid.UUID, portfolio_id: int
) -> Portfolio:
    if isinstance(portfolio_id, bool) or not isinstance(portfolio_id, int) or portfolio_id <= 0:
        raise CloudServiceValidationError("portfolio_id must be a positive integer")
    portfolio = PortfolioRepository().get_for_profile(
        session, profile_id=profile_id, portfolio_id=portfolio_id
    )
    if portfolio is None:
        raise CloudResourceNotFoundError("portfolio not found")
    return portfolio


def _watchlist_for_profile(
    session: Session, *, profile_id: uuid.UUID, watchlist_id: int
) -> Watchlist:
    if isinstance(watchlist_id, bool) or not isinstance(watchlist_id, int) or watchlist_id <= 0:
        raise CloudServiceValidationError("watchlist_id must be a positive integer")
    watchlist = WatchlistRepository().get_for_profile(
        session, profile_id=profile_id, watchlist_id=watchlist_id
    )
    if watchlist is None:
        # Deliberately do not reveal whether the identifier exists for another
        # user.  The authenticated profile is always part of the lookup.
        raise CloudResourceNotFoundError("watchlist not found")
    return watchlist


def portfolio_payload(portfolio: Portfolio) -> dict[str, Any]:
    """Stable JSON-ready portfolio representation for future API routes."""

    return {
        "id": int(portfolio.id),
        "name": portfolio.name,
        "currency": portfolio.currency,
        "is_default": bool(portfolio.is_default),
        "sort_order": int(portfolio.sort_order),
        "archived_at": portfolio.archived_at.isoformat() if portfolio.archived_at else None,
        "created_at": portfolio.created_at.isoformat() if portfolio.created_at else None,
        "updated_at": portfolio.updated_at.isoformat() if portfolio.updated_at else None,
    }


def watchlist_item_payload(item: WatchlistItem) -> dict[str, Any]:
    """Stable JSON-ready watchlist item representation for future API routes."""

    return {
        "id": int(item.id),
        "ticker": item.ticker,
        "sort_order": int(item.sort_order),
        "added_at": item.added_at.isoformat() if item.added_at else None,
    }


def watchlist_payload(watchlist: Watchlist, *, include_items: bool = False) -> dict[str, Any]:
    """Stable JSON-ready watchlist representation, optionally including items."""

    payload: dict[str, Any] = {
        "id": int(watchlist.id),
        "name": watchlist.name,
        "is_default": bool(watchlist.is_default),
        "is_favorite": bool(watchlist.is_favorite),
        "is_pinned": bool(watchlist.is_pinned),
        "sort_order": int(watchlist.sort_order),
        "created_at": watchlist.created_at.isoformat() if watchlist.created_at else None,
        "updated_at": watchlist.updated_at.isoformat() if watchlist.updated_at else None,
    }
    if include_items:
        payload["items"] = [
            watchlist_item_payload(item)
            for item in sorted(watchlist.items, key=lambda item: (item.sort_order, item.id))
        ]
    return payload


def provisional_username(profile_id: uuid.UUID) -> str:
    """A deterministic, unique-enough value kept only until onboarding finishes."""
    return f"user-{profile_id.hex[:16]}"


def ensure_workspace(
    session: Session,
    *,
    profile_id: uuid.UUID,
    email: str | None,
    avatar_url: str | None,
) -> tuple[Profile, Watchlist, UserPreference]:
    workspace = ProfileRepository().ensure_workspace(
        session,
        profile_id=profile_id,
        username=provisional_username(profile_id),
        email=email,
        avatar_url=avatar_url,
    )
    return workspace.profile, workspace.default_watchlist, workspace.preferences


def profile_payload(profile: Profile) -> dict[str, Any]:
    return {
        "id": str(profile.id),
        "email": profile.email,
        "username": profile.username,
        "avatar_url": profile.avatar_url,
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "last_login_at": profile.last_login_at.isoformat() if profile.last_login_at else None,
        "needs_onboarding": ProfileRepository.needs_onboarding(profile),
        "is_provisional_username": profile.username.casefold()
        == provisional_username(profile.id).casefold(),
    }


def list_default_watchlist_tickers(session: Session, profile_id: uuid.UUID) -> list[str]:
    watchlist = session.scalar(
        select(Watchlist)
        .where(Watchlist.profile_id == profile_id, Watchlist.is_default.is_(True))
        .join(Watchlist.items, isouter=True)
    )
    if watchlist is None:
        return []
    return [item.ticker for item in sorted(watchlist.items, key=lambda item: (item.sort_order, item.id))]


def add_default_watchlist_ticker(session: Session, profile_id: uuid.UUID, ticker: str) -> list[str]:
    watchlist = session.scalar(
        select(Watchlist).where(Watchlist.profile_id == profile_id, Watchlist.is_default.is_(True))
    )
    if watchlist is None:
        raise LookupError("default watchlist does not exist")
    existing = session.scalar(
        select(WatchlistItem).where(WatchlistItem.watchlist_id == watchlist.id, WatchlistItem.ticker == ticker)
    )
    if existing is None:
        max_sort = session.scalar(
            select(WatchlistItem.sort_order)
            .where(WatchlistItem.watchlist_id == watchlist.id)
            .order_by(WatchlistItem.sort_order.desc())
            .limit(1)
        )
        try:
            with session.begin_nested():
                session.add(
                    WatchlistItem(
                        watchlist_id=watchlist.id,
                        ticker=ticker,
                        sort_order=(max_sort or 0) + 1,
                    )
                )
                session.flush()
        except IntegrityError:
            # A parallel tab added the same ticker first; the endpoint remains
            # idempotent and returns the authoritative ordered list.
            pass
    return list_default_watchlist_tickers(session, profile_id)


def remove_default_watchlist_ticker(session: Session, profile_id: uuid.UUID, ticker: str) -> list[str]:
    item = session.scalar(
        select(WatchlistItem)
        .join(WatchlistItem.watchlist)
        .where(
            Watchlist.profile_id == profile_id,
            Watchlist.is_default.is_(True),
            WatchlistItem.ticker == ticker,
        )
    )
    if item is not None:
        session.delete(item)
        session.flush()
    return list_default_watchlist_tickers(session, profile_id)


def list_portfolios(
    session: Session,
    *,
    profile_id: uuid.UUID,
    include_archived: bool = False,
) -> list[Portfolio]:
    """List only portfolios owned by ``profile_id`` in display order.

    Archived portfolios are intentionally excluded unless a profile/settings
    screen explicitly asks for them.  The standard dashboard should not need
    to remember to filter them itself.
    """

    if not isinstance(include_archived, bool):
        raise CloudServiceValidationError("include_archived must be true or false")
    if not include_archived:
        return PortfolioRepository().list_for_profile(session, profile_id)
    return list(
        session.scalars(
            select(Portfolio)
            .where(Portfolio.profile_id == profile_id)
            .order_by(Portfolio.archived_at.is_not(None), Portfolio.sort_order, Portfolio.created_at)
        )
    )


def create_portfolio(
    session: Session,
    *,
    profile_id: uuid.UUID,
    name: str,
    currency: str = "USD",
    sort_order: int | None = None,
) -> Portfolio:
    """Create a non-default portfolio for the authenticated profile.

    The caller owns the surrounding transaction.  A database uniqueness
    constraint still protects the same-name race between two browser tabs;
    API routes should map an ``IntegrityError`` to a conflict response.
    """

    normalized_name = normalize_portfolio_name(name)
    normalized_currency = normalize_portfolio_currency(currency)
    desired_sort_order = (
        _next_portfolio_sort_order(session, profile_id)
        if sort_order is None
        else normalize_sort_order(sort_order)
    )
    existing = session.scalar(
        select(Portfolio.id).where(
            Portfolio.profile_id == profile_id,
            func.lower(Portfolio.name) == normalized_name.lower(),
        )
    )
    if existing is not None:
        raise CloudServiceValidationError("a portfolio with this name already exists")

    portfolio = Portfolio(
        profile_id=profile_id,
        name=normalized_name,
        currency=normalized_currency,
        is_default=False,
        sort_order=desired_sort_order,
    )
    session.add(portfolio)
    session.flush()
    return portfolio


def rename_portfolio(
    session: Session,
    *,
    profile_id: uuid.UUID,
    portfolio_id: int,
    name: str,
    currency: str | None = None,
) -> Portfolio:
    """Update an active portfolio after proving profile ownership."""

    portfolio = _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
    if portfolio.archived_at is not None:
        raise CloudServiceValidationError("archived portfolios cannot be renamed")
    normalized_name = normalize_portfolio_name(name)
    conflicting_id = session.scalar(
        select(Portfolio.id).where(
            Portfolio.profile_id == profile_id,
            func.lower(Portfolio.name) == normalized_name.lower(),
            Portfolio.id != portfolio.id,
        )
    )
    if conflicting_id is not None:
        raise CloudServiceValidationError("a portfolio with this name already exists")
    portfolio.name = normalized_name
    if currency is not None:
        portfolio.currency = normalize_portfolio_currency(currency)
    session.flush()
    return portfolio


def archive_portfolio(
    session: Session,
    *,
    profile_id: uuid.UUID,
    portfolio_id: int,
    archived_at: datetime | None = None,
) -> Portfolio:
    """Archive (never hard-delete) a non-default portfolio owned by a user."""

    portfolio = _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
    if portfolio.is_default:
        raise DefaultResourceProtectionError("the default portfolio cannot be archived")
    if portfolio.archived_at is not None:
        raise CloudServiceValidationError("portfolio is already archived")
    portfolio.archived_at = _as_utc(archived_at)
    session.flush()
    return portfolio


def list_watchlists(session: Session, *, profile_id: uuid.UUID) -> list[Watchlist]:
    """List only watchlists owned by the authenticated profile, with items loaded."""

    return WatchlistRepository().list_for_profile(session, profile_id)


def create_watchlist(
    session: Session,
    *,
    profile_id: uuid.UUID,
    name: str,
    is_favorite: bool = False,
    is_pinned: bool = False,
    sort_order: int | None = None,
) -> Watchlist:
    """Create a user-owned, non-default watchlist with no initial items."""

    normalized_name = normalize_watchlist_name(name)
    favorite = _require_bool(is_favorite, field="is_favorite")
    pinned = _require_bool(is_pinned, field="is_pinned")
    if sort_order is None:
        current_max = session.scalar(
            select(func.max(Watchlist.sort_order)).where(Watchlist.profile_id == profile_id)
        )
        desired_sort_order = 0 if current_max is None else normalize_sort_order(int(current_max) + 1)
    else:
        desired_sort_order = normalize_sort_order(sort_order)
    existing = session.scalar(
        select(Watchlist.id).where(
            Watchlist.profile_id == profile_id,
            func.lower(Watchlist.name) == normalized_name.lower(),
        )
    )
    if existing is not None:
        raise CloudServiceValidationError("a watchlist with this name already exists")

    watchlist = Watchlist(
        profile_id=profile_id,
        name=normalized_name,
        is_default=False,
        is_favorite=favorite,
        is_pinned=pinned,
        sort_order=desired_sort_order,
    )
    session.add(watchlist)
    session.flush()
    return watchlist


def update_watchlist(
    session: Session,
    *,
    profile_id: uuid.UUID,
    watchlist_id: int,
    name: str | None = None,
    is_favorite: bool | None = None,
    is_pinned: bool | None = None,
    sort_order: int | None = None,
) -> Watchlist:
    """Apply selected metadata updates to an owned watchlist.

    ``None`` means "leave unchanged".  Explicit boolean fields must be real
    booleans rather than truthy strings, which prevents accidental state flips
    from loosely parsed request data.
    """

    if name is None and is_favorite is None and is_pinned is None and sort_order is None:
        raise CloudServiceValidationError("at least one watchlist field must be supplied")
    watchlist = _watchlist_for_profile(session, profile_id=profile_id, watchlist_id=watchlist_id)
    if name is not None:
        normalized_name = normalize_watchlist_name(name)
        conflicting_id = session.scalar(
            select(Watchlist.id).where(
                Watchlist.profile_id == profile_id,
                func.lower(Watchlist.name) == normalized_name.lower(),
                Watchlist.id != watchlist.id,
            )
        )
        if conflicting_id is not None:
            raise CloudServiceValidationError("a watchlist with this name already exists")
        watchlist.name = normalized_name
    if is_favorite is not None:
        watchlist.is_favorite = _require_bool(is_favorite, field="is_favorite")
    if is_pinned is not None:
        watchlist.is_pinned = _require_bool(is_pinned, field="is_pinned")
    if sort_order is not None:
        watchlist.sort_order = normalize_sort_order(sort_order)
    session.flush()
    return watchlist


def delete_watchlist(session: Session, *, profile_id: uuid.UUID, watchlist_id: int) -> None:
    """Hard-delete a non-default owned watchlist and its cascading items.

    Default watchlists are the anchor used by legacy-compatible routes and are
    therefore intentionally not deletable.  They may still be renamed or have
    their items managed through the ordinary helpers.
    """

    watchlist = _watchlist_for_profile(session, profile_id=profile_id, watchlist_id=watchlist_id)
    if watchlist.is_default:
        raise DefaultResourceProtectionError("the default watchlist cannot be deleted")
    session.delete(watchlist)
    session.flush()


def list_watchlist_items(
    session: Session, *, profile_id: uuid.UUID, watchlist_id: int
) -> list[WatchlistItem]:
    """List ordered items for one watchlist proved to belong to ``profile_id``."""

    watchlist = _watchlist_for_profile(session, profile_id=profile_id, watchlist_id=watchlist_id)
    return sorted(watchlist.items, key=lambda item: (item.sort_order, item.id))


def _resequence_watchlist_items(items: Sequence[WatchlistItem]) -> None:
    """Persist a gap-free, zero-based ordering on an already validated sequence."""

    for sort_order, item in enumerate(items):
        item.sort_order = sort_order


def add_watchlist_item(
    session: Session,
    *,
    profile_id: uuid.UUID,
    watchlist_id: int,
    ticker: str,
    sort_order: int | None = None,
) -> WatchlistItem:
    """Add a ticker to an owned watchlist, or return the existing item.

    When ``sort_order`` is supplied it is a zero-based insertion position.  A
    position beyond the end is rejected rather than silently producing a
    sparse order.  Duplicate ticker adds are idempotent and leave the current
    item position unchanged.
    """

    watchlist = _watchlist_for_profile(session, profile_id=profile_id, watchlist_id=watchlist_id)
    normalized_ticker = normalize_watchlist_ticker(ticker)
    items = sorted(watchlist.items, key=lambda item: (item.sort_order, item.id))
    existing = next((item for item in items if item.ticker == normalized_ticker), None)
    if existing is not None:
        return existing

    insertion_index = len(items)
    if sort_order is not None:
        insertion_index = normalize_sort_order(sort_order)
        if insertion_index > len(items):
            raise CloudServiceValidationError(
                f"sort_order must be between 0 and {len(items)} for this watchlist"
            )
    item = WatchlistItem(
        watchlist_id=watchlist.id,
        ticker=normalized_ticker,
        sort_order=insertion_index,
    )
    session.add(item)
    # Keep the already eager-loaded relationship coherent for the rest of the
    # request.  Setting only ``watchlist_id`` would leave a cached collection
    # stale until it is expired or reloaded.
    watchlist.items.append(item)
    items.insert(insertion_index, item)
    # SQLAlchemy preserves append order in an in-memory relationship; assign
    # the complete ordered sequence so a response built in this same request
    # agrees with the stored ``sort_order`` values.
    watchlist.items[:] = items
    _resequence_watchlist_items(items)
    session.flush()
    return item


def remove_watchlist_item(
    session: Session,
    *,
    profile_id: uuid.UUID,
    watchlist_id: int,
    ticker: str | None = None,
    item_id: int | None = None,
) -> WatchlistItem:
    """Remove one owned item selected by exactly one of ticker or item ID."""

    if (ticker is None) == (item_id is None):
        raise CloudServiceValidationError("supply exactly one of ticker or item_id")
    watchlist = _watchlist_for_profile(session, profile_id=profile_id, watchlist_id=watchlist_id)
    items = sorted(watchlist.items, key=lambda item: (item.sort_order, item.id))
    item: WatchlistItem | None
    if ticker is not None:
        normalized_ticker = normalize_watchlist_ticker(ticker)
        item = next((candidate for candidate in items if candidate.ticker == normalized_ticker), None)
    else:
        if isinstance(item_id, bool) or not isinstance(item_id, int) or item_id <= 0:
            raise CloudServiceValidationError("item_id must be a positive integer")
        item = next((candidate for candidate in items if candidate.id == item_id), None)
    if item is None:
        raise CloudResourceNotFoundError("watchlist item not found")

    items.remove(item)
    watchlist.items.remove(item)
    watchlist.items[:] = items
    session.delete(item)
    _resequence_watchlist_items(items)
    session.flush()
    return item


def reorder_watchlist_items(
    session: Session,
    *,
    profile_id: uuid.UUID,
    watchlist_id: int,
    item_ids: Sequence[int],
) -> list[WatchlistItem]:
    """Atomically apply a complete, ordered item-ID list to one watchlist.

    Requiring the full set makes a stale drag-and-drop request fail explicitly
    instead of dropping an item that was added in another browser tab.
    """

    if isinstance(item_ids, (str, bytes)) or not isinstance(item_ids, Sequence):
        raise CloudServiceValidationError("item_ids must be an ordered list of item IDs")
    normalized_ids: list[int] = []
    for item_id in item_ids:
        if isinstance(item_id, bool) or not isinstance(item_id, int) or item_id <= 0:
            raise CloudServiceValidationError("each item_id must be a positive integer")
        normalized_ids.append(item_id)
    if len(set(normalized_ids)) != len(normalized_ids):
        raise CloudServiceValidationError("item_ids cannot contain duplicates")

    watchlist = _watchlist_for_profile(session, profile_id=profile_id, watchlist_id=watchlist_id)
    current_items = sorted(watchlist.items, key=lambda item: (item.sort_order, item.id))
    current_by_id = {int(item.id): item for item in current_items}
    if set(normalized_ids) != set(current_by_id):
        raise CloudServiceValidationError(
            "item_ids must contain every current item exactly once; refresh and retry"
        )
    ordered_items = [current_by_id[item_id] for item_id in normalized_ids]
    watchlist.items[:] = ordered_items
    _resequence_watchlist_items(ordered_items)
    session.flush()
    return ordered_items


def _decimal(value: Any, name: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a valid number") from exc
    if not result.is_finite():
        raise ValueError(f"{name} must be finite")
    return result


def create_option_position(
    session: Session,
    *,
    profile_id: uuid.UUID,
    ticker: str,
    strike_price: float,
    option_type: str,
    expiration: str,
    premium_paid: float,
    quantity: int,
    iv: float,
    delta: float,
    entry_underlying_price: float,
    portfolio_id: int | None = None,
) -> Position:
    # A supplied portfolio is always looked up through the authenticated
    # profile; callers can never attach a contract to another user's account.
    portfolio = (
        _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
        if portfolio_id is not None
        else session.scalar(
            select(Portfolio).where(Portfolio.profile_id == profile_id, Portfolio.is_default.is_(True))
        )
    )
    if portfolio is None:
        raise LookupError("default portfolio does not exist")
    if portfolio.archived_at is not None:
        raise CloudServiceValidationError("cannot add a position to an archived portfolio")
    position = Position(
        portfolio_id=portfolio.id,
        ticker=ticker,
        underlying_ticker=ticker,
        asset_type="option",
        quantity=_decimal(quantity, "quantity"),
        average_cost=_decimal(premium_paid, "premium_paid"),
        strike_price=_decimal(strike_price, "strike_price"),
        option_type=option_type.upper(),
        expiration=date.fromisoformat(expiration),
        is_open=True,
        metadata_json={
            "iv": float(iv),
            "delta": float(delta),
            "premium_paid": float(premium_paid),
            "entry_underlying_price": float(entry_underlying_price),
        },
    )
    session.add(position)
    session.flush()
    return position


def list_open_option_positions(
    session: Session, profile_id: uuid.UUID, portfolio_id: int | None = None
) -> list[Position]:
    statement = (
        select(Position)
        .join(Portfolio, Position.portfolio_id == Portfolio.id)
        .where(
            Portfolio.profile_id == profile_id,
            Position.is_open.is_(True),
            Position.asset_type == "option",
        )
        .order_by(Position.opened_at.desc(), Position.id.desc())
    )
    if portfolio_id is not None:
        portfolio = _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
        statement = statement.where(Position.portfolio_id == portfolio.id)
    return list(session.scalars(statement))


def close_option_position(session: Session, *, profile_id: uuid.UUID, position_id: int) -> Position | None:
    position = session.scalar(
        select(Position)
        .join(Portfolio, Position.portfolio_id == Portfolio.id)
        .where(
            Position.id == position_id,
            Portfolio.profile_id == profile_id,
            Position.is_open.is_(True),
            Position.asset_type == "option",
        )
    )
    if position is None:
        return None
    position.is_open = False
    position.closed_at = date.today()
    session.flush()
    return position


def update_option_position(
    session: Session,
    *,
    profile_id: uuid.UUID,
    position_id: int,
    strike_price: float,
    option_type: str,
    expiration: str,
    premium_paid: float,
    quantity: int,
    iv: float,
    delta: float,
) -> Position | None:
    """Update only an owned, open option position in the caller transaction."""
    position = session.scalar(
        select(Position)
        .join(Portfolio, Position.portfolio_id == Portfolio.id)
        .where(
            Position.id == position_id,
            Portfolio.profile_id == profile_id,
            Position.is_open.is_(True),
            Position.asset_type == "option",
        )
    )
    if position is None:
        return None
    position.strike_price = _decimal(strike_price, "strike_price")
    position.option_type = option_type.upper()
    position.expiration = date.fromisoformat(expiration)
    position.average_cost = _decimal(premium_paid, "premium_paid")
    position.quantity = _decimal(quantity, "quantity")
    metadata = dict(position.metadata_json or {})
    metadata.update({"iv": float(iv), "delta": float(delta), "premium_paid": float(premium_paid)})
    position.metadata_json = metadata
    session.flush()
    return position


def _stock_holding_for_profile(
    session: Session, *, profile_id: uuid.UUID, holding_id: int
) -> StockHolding | None:
    if isinstance(holding_id, bool) or not isinstance(holding_id, int) or holding_id <= 0:
        raise CloudServiceValidationError("holding_id must be a positive integer")
    return session.scalar(
        select(StockHolding)
        .join(Portfolio, StockHolding.portfolio_id == Portfolio.id)
        .where(StockHolding.id == holding_id, Portfolio.profile_id == profile_id)
    )


def _trade_date(value: str | None) -> date:
    if value is None:
        return date.today()
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise CloudServiceValidationError("traded_at must be YYYY-MM-DD") from exc


def record_stock_trade(
    session: Session,
    *,
    profile_id: uuid.UUID,
    portfolio_id: int,
    ticker: str,
    side: str,
    shares: float,
    price: float,
    notes: str | None = None,
    traded_at: str | None = None,
) -> StockHolding:
    """Record a buy/sell and atomically update its holding projection.

    Average cost uses a weighted-average method.  A sale preserves the
    holding (including a zero-share holding) so the complete trade history and
    realized P&L stay available in transaction history.
    """

    portfolio = _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
    if portfolio.archived_at is not None:
        raise CloudServiceValidationError("cannot trade in an archived portfolio")
    symbol = normalize_watchlist_ticker(ticker)
    normalized_side = str(side or "").upper().strip()
    if normalized_side not in {"BUY", "SELL"}:
        raise CloudServiceValidationError("side must be BUY or SELL")
    try:
        quantity = _decimal(shares, "shares")
        unit_price = _decimal(price, "price")
    except ValueError as exc:
        raise CloudServiceValidationError(str(exc)) from exc
    if quantity <= 0:
        raise CloudServiceValidationError("shares must be greater than 0")
    if unit_price < 0:
        raise CloudServiceValidationError("price must be at least 0")
    trade_notes = normalize_stock_notes(notes)

    holding = session.scalar(
        select(StockHolding).where(
            StockHolding.portfolio_id == portfolio.id,
            StockHolding.ticker == symbol,
        )
    )
    if holding is None:
        if normalized_side == "SELL":
            raise CloudServiceValidationError("cannot sell a stock that is not held in this portfolio")
        holding = StockHolding(
            portfolio_id=portfolio.id,
            ticker=symbol,
            shares=Decimal("0"),
            average_cost=Decimal("0"),
            realized_pnl=Decimal("0"),
            notes=trade_notes,
        )
        session.add(holding)
        session.flush()
    elif trade_notes is not None:
        # Trade notes are historical; an explicit note also remains visible on
        # the holding as the user-facing current note.
        holding.notes = trade_notes

    if normalized_side == "BUY":
        new_shares = holding.shares + quantity
        holding.average_cost = ((holding.shares * holding.average_cost) + (quantity * unit_price)) / new_shares
        holding.shares = new_shares
    else:
        if quantity > holding.shares:
            raise CloudServiceValidationError("sell shares cannot exceed the current holding")
        holding.realized_pnl = holding.realized_pnl + ((unit_price - holding.average_cost) * quantity)
        holding.shares = holding.shares - quantity

    transaction = StockTransaction(
        holding_id=holding.id,
        side=normalized_side,
        shares=quantity,
        price=unit_price,
        notes=trade_notes,
        traded_at=_trade_date(traded_at),
    )
    session.add(transaction)
    session.flush()
    return holding


def update_stock_holding_notes(
    session: Session, *, profile_id: uuid.UUID, holding_id: int, notes: str | None
) -> StockHolding | None:
    holding = _stock_holding_for_profile(session, profile_id=profile_id, holding_id=holding_id)
    if holding is None:
        return None
    if holding.portfolio.archived_at is not None:
        raise CloudServiceValidationError("cannot update a holding in an archived portfolio")
    holding.notes = normalize_stock_notes(notes)
    session.flush()
    return holding


def list_stock_holdings(
    session: Session,
    *,
    profile_id: uuid.UUID,
    portfolio_id: int | None = None,
    include_closed: bool = False,
    offset: int | None = None,
    limit: int | None = None,
) -> list[StockHolding]:
    statement = (
        select(StockHolding)
        .join(Portfolio, StockHolding.portfolio_id == Portfolio.id)
        .where(Portfolio.profile_id == profile_id)
        .order_by(StockHolding.ticker)
    )
    if portfolio_id is not None:
        portfolio = _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
        statement = statement.where(StockHolding.portfolio_id == portfolio.id)
    if not include_closed:
        statement = statement.where(StockHolding.shares > 0)
    if offset is not None:
        statement = statement.offset(offset)
    if limit is not None:
        statement = statement.limit(limit)
    return list(session.scalars(statement))


def list_stock_transactions(
    session: Session, *, profile_id: uuid.UUID, portfolio_id: int | None = None
) -> list[StockTransaction]:
    statement = (
        select(StockTransaction)
        .join(StockHolding, StockTransaction.holding_id == StockHolding.id)
        .join(Portfolio, StockHolding.portfolio_id == Portfolio.id)
        .where(Portfolio.profile_id == profile_id)
        .order_by(StockTransaction.traded_at.desc(), StockTransaction.id.desc())
    )
    if portfolio_id is not None:
        portfolio = _portfolio_for_profile(session, profile_id=profile_id, portfolio_id=portfolio_id)
        statement = statement.where(StockHolding.portfolio_id == portfolio.id)
    return list(session.scalars(statement))


def stock_holding_payload(holding: StockHolding, *, current_price: float | None = None) -> dict[str, Any]:
    shares = float(holding.shares)
    average_cost = float(holding.average_cost)
    live_price = float(current_price) if current_price is not None else None
    market_value = live_price * shares if live_price is not None else None
    unrealized_pnl = (live_price - average_cost) * shares if live_price is not None else None
    history = {
        side: [
            {
                "id": int(transaction.id), "shares": float(transaction.shares),
                "price": float(transaction.price), "notes": transaction.notes,
                "traded_at": transaction.traded_at.isoformat(),
            }
            for transaction in sorted(holding.transactions, key=lambda item: (item.traded_at, item.id))
            if transaction.side == side
        ]
        for side in ("BUY", "SELL")
    }
    return {
        "id": int(holding.id), "portfolio_id": int(holding.portfolio_id), "ticker": holding.ticker,
        "shares": shares, "average_cost": average_cost, "current_price": live_price,
        "market_value": market_value, "profit_loss": unrealized_pnl,
        "unrealized_pnl": unrealized_pnl, "realized_pnl": float(holding.realized_pnl),
        "notes": holding.notes, "created_at": holding.created_at.isoformat() if holding.created_at else None,
        "updated_at": holding.updated_at.isoformat() if holding.updated_at else None,
        "buy_history": history["BUY"], "sell_history": history["SELL"],
    }


def stock_transaction_payload(transaction: StockTransaction) -> dict[str, Any]:
    holding = transaction.holding
    return {
        "id": int(transaction.id), "holding_id": int(transaction.holding_id),
        "portfolio_id": int(holding.portfolio_id), "ticker": holding.ticker, "side": transaction.side,
        "shares": float(transaction.shares), "price": float(transaction.price), "notes": transaction.notes,
        "traded_at": transaction.traded_at.isoformat(),
    }


def legacy_position_payload(position: Position) -> dict[str, Any]:
    metadata = position.metadata_json or {}
    ticker = position.underlying_ticker or position.ticker
    return {
        "id": int(position.id),
        "portfolio_id": int(position.portfolio_id),
        "ticker": ticker,
        "strike_price": float(position.strike_price or 0),
        "option_type": str(position.option_type or "CALL").upper(),
        "expiration": position.expiration.isoformat() if position.expiration else "",
        "premium_paid": float(position.average_cost),
        "quantity": int(position.quantity),
        "iv": float(metadata.get("iv") or 0),
        "delta": float(metadata.get("delta") or 0),
        "entry_underlying_price": float(metadata.get("entry_underlying_price") or 0),
        "pnl": 0.0,
        "pnl_percent": 0.0,
    }


def preference_payload(preference: UserPreference) -> dict[str, Any]:
    settings = preference.settings or {}
    return {
        "theme": preference.theme,
        "language": preference.language,
        "currency": settings.get("currency", "USD"),
        "timezone": settings.get("timezone", "UTC"),
        "default_timeframe": settings.get("default_timeframe", "1d"),
        "default_indicator": settings.get("default_indicator", "Smart S/R"),
        "ema_settings": settings.get("ema_settings"),
        "ema_master_enabled": settings.get("ema_master_enabled"),
    }


def update_preferences(
    preference: UserPreference,
    *,
    ema_settings: dict[str, Any] | None = None,
    ema_master_enabled: bool | None = None,
    theme: str | None = None,
    language: str | None = None,
    currency: str | None = None,
    timezone: str | None = None,
    default_timeframe: str | None = None,
    default_indicator: str | None = None,
) -> UserPreference:
    settings = dict(preference.settings or {})
    if theme is not None:
        if theme not in {"dark", "light", "system"}:
            raise ValueError("theme must be dark, light, or system")
        preference.theme = theme
    if language is not None:
        normalized_language = language.strip()
        if not 2 <= len(normalized_language) <= 12:
            raise ValueError("language must contain 2 to 12 characters")
        preference.language = normalized_language
    if ema_settings is not None:
        if not isinstance(ema_settings, dict):
            raise ValueError("ema_settings must be an object")
        if len(str(ema_settings)) > 20_000:
            raise ValueError("ema_settings is too large")
        settings["ema_settings"] = ema_settings
    if ema_master_enabled is not None:
        settings["ema_master_enabled"] = bool(ema_master_enabled)
    if currency is not None:
        settings["currency"] = normalize_portfolio_currency(currency)
    if timezone is not None:
        normalized_timezone = timezone.strip()
        if not normalized_timezone or len(normalized_timezone) > 64:
            raise ValueError("timezone must contain 1 to 64 characters")
        settings["timezone"] = normalized_timezone
    if default_timeframe is not None:
        normalized_timeframe = default_timeframe.strip()
        if not normalized_timeframe or len(normalized_timeframe) > 16:
            raise ValueError("default_timeframe must contain 1 to 16 characters")
        settings["default_timeframe"] = normalized_timeframe
    if default_indicator is not None:
        normalized_indicator = default_indicator.strip()
        if not normalized_indicator or len(normalized_indicator) > 48:
            raise ValueError("default_indicator must contain 1 to 48 characters")
        settings["default_indicator"] = normalized_indicator
    preference.settings = settings
    return preference
