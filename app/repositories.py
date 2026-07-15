"""Small sync repositories used by future authenticated API routes.

They are intentionally independent from FastAPI and the legacy in-memory
routes, so the migration can happen endpoint by endpoint without changing
existing payload contracts.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .models import Portfolio, Position, Profile, UserPreference, Watchlist

DEFAULT_PORTFOLIO_NAME = "Main"
DEFAULT_WATCHLIST_NAME = "Watchlist"


def _normalize_username(value: str) -> str:
    normalized = value.strip()
    if not 3 <= len(normalized) <= 32:
        raise ValueError("username must contain between 3 and 32 characters")
    return normalized


def _normalize_email(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if len(normalized) > 320 or "@" not in normalized:
        raise ValueError("email must be a valid email address")
    return normalized


@dataclass(frozen=True, slots=True)
class UserWorkspace:
    profile: Profile
    default_portfolio: Portfolio
    default_watchlist: Watchlist
    preferences: UserPreference


class ProfileRepository:
    """Profile and first-login defaults with a transaction owned by the caller."""

    def get(self, session: Session, profile_id: uuid.UUID) -> Profile | None:
        return session.get(Profile, profile_id)

    def get_workspace(self, session: Session, profile_id: uuid.UUID) -> Profile | None:
        statement: Select[tuple[Profile]] = (
            select(Profile)
            .where(Profile.id == profile_id)
            .options(
                selectinload(Profile.preferences),
                selectinload(Profile.portfolios),
                selectinload(Profile.watchlists),
            )
        )
        return session.scalar(statement)

    @staticmethod
    def needs_onboarding(profile: Profile) -> bool:
        """Return whether the authenticated user still needs first-time setup."""

        return profile.onboarding_completed_at is None

    def complete_onboarding(
        self,
        session: Session,
        *,
        profile_id: uuid.UUID,
        username: str,
        completed_at: datetime | None = None,
    ) -> Profile:
        """Persist the user-chosen username and mark first-time setup complete.

        The caller must already have verified that ``profile_id`` is the auth
        subject.  A missing profile is deliberately an error instead of
        silently creating one with an unverified identity.
        """

        profile = session.get(Profile, profile_id)
        if profile is None:
            raise LookupError("profile does not exist")
        normalized_username = _normalize_username(username)
        provisional = f"user-{profile_id.hex[:16]}"
        if normalized_username.casefold() == provisional.casefold():
            raise ValueError("Please choose a username instead of the temporary account name.")
        profile.username = normalized_username
        profile.onboarding_completed_at = completed_at or datetime.now(timezone.utc)
        session.flush()
        return profile

    def ensure_workspace(
        self,
        session: Session,
        *,
        profile_id: uuid.UUID,
        username: str,
        email: str | None = None,
        avatar_url: str | None = None,
        last_login_at: datetime | None = None,
    ) -> UserWorkspace:
        """Create the profile and exactly one default portfolio/watchlist if absent.

        Call this inside the authenticated request's transaction.  The partial
        unique indexes in the schema make duplicate defaults impossible even
        when two first-login requests race; a route can retry on IntegrityError
        and then call this method again.
        """

        normalized_username = _normalize_username(username)
        normalized_email = _normalize_email(email)
        profile = session.get(Profile, profile_id)
        now = last_login_at or datetime.now(timezone.utc)

        if profile is None:
            # Two tabs can both be the first authenticated request.  A nested
            # transaction turns the unique-key race into a re-query instead of
            # rolling back the caller's whole workspace transaction.
            try:
                with session.begin_nested():
                    session.add(
                        Profile(
                            id=profile_id,
                            username=normalized_username,
                            email=normalized_email,
                            avatar_url=avatar_url,
                            last_login_at=now,
                        )
                    )
                    session.flush()
            except IntegrityError:
                profile = session.get(Profile, profile_id)
                if profile is None:
                    raise
            else:
                profile = session.get(Profile, profile_id)
                assert profile is not None
        else:
            # Auth identity is authoritative for email/avatar/login time.  Do
            # not overwrite a user-selected username after first-time setup.
            profile.email = normalized_email or profile.email
            # A user-selected image is stored on the profile.  Do not replace
            # it with a provider avatar on every authenticated request.
            profile.avatar_url = profile.avatar_url or avatar_url
            profile.last_login_at = now

        preferences = session.get(UserPreference, profile_id)
        if preferences is None:
            try:
                with session.begin_nested():
                    session.add(UserPreference(profile_id=profile_id))
                    session.flush()
            except IntegrityError:
                preferences = session.get(UserPreference, profile_id)
                if preferences is None:
                    raise
            else:
                preferences = session.get(UserPreference, profile_id)
                assert preferences is not None

        default_portfolio = session.scalar(
            select(Portfolio)
            .where(Portfolio.profile_id == profile_id, Portfolio.is_default.is_(True))
            .with_for_update()
        )
        if default_portfolio is None:
            try:
                with session.begin_nested():
                    session.add(
                        Portfolio(
                            profile_id=profile_id,
                            name=DEFAULT_PORTFOLIO_NAME,
                            is_default=True,
                            sort_order=0,
                        )
                    )
                    session.flush()
            except IntegrityError:
                default_portfolio = session.scalar(
                    select(Portfolio).where(
                        Portfolio.profile_id == profile_id, Portfolio.is_default.is_(True)
                    )
                )
                if default_portfolio is None:
                    raise
            else:
                default_portfolio = session.scalar(
                    select(Portfolio).where(
                        Portfolio.profile_id == profile_id, Portfolio.is_default.is_(True)
                    )
                )
                assert default_portfolio is not None

        default_watchlist = session.scalar(
            select(Watchlist)
            .where(Watchlist.profile_id == profile_id, Watchlist.is_default.is_(True))
            .with_for_update()
        )
        if default_watchlist is None:
            try:
                with session.begin_nested():
                    session.add(
                        Watchlist(
                            profile_id=profile_id,
                            name=DEFAULT_WATCHLIST_NAME,
                            is_default=True,
                            sort_order=0,
                        )
                    )
                    session.flush()
            except IntegrityError:
                default_watchlist = session.scalar(
                    select(Watchlist).where(
                        Watchlist.profile_id == profile_id, Watchlist.is_default.is_(True)
                    )
                )
                if default_watchlist is None:
                    raise
            else:
                default_watchlist = session.scalar(
                    select(Watchlist).where(
                        Watchlist.profile_id == profile_id, Watchlist.is_default.is_(True)
                    )
                )
                assert default_watchlist is not None

        session.flush()
        return UserWorkspace(
            profile=profile,
            default_portfolio=default_portfolio,
            default_watchlist=default_watchlist,
            preferences=preferences,
        )


class PortfolioRepository:
    """Ownership-scoped portfolio queries for authenticated routes."""

    def list_for_profile(self, session: Session, profile_id: uuid.UUID) -> list[Portfolio]:
        return list(
            session.scalars(
                select(Portfolio)
                .where(Portfolio.profile_id == profile_id, Portfolio.archived_at.is_(None))
                .order_by(Portfolio.sort_order, Portfolio.created_at)
            )
        )

    def get_for_profile(
        self, session: Session, *, profile_id: uuid.UUID, portfolio_id: int
    ) -> Portfolio | None:
        return session.scalar(
            select(Portfolio).where(Portfolio.id == portfolio_id, Portfolio.profile_id == profile_id)
        )


class WatchlistRepository:
    """Ownership-scoped watchlist queries; never query an ID without a profile."""

    def list_for_profile(self, session: Session, profile_id: uuid.UUID) -> list[Watchlist]:
        return list(
            session.scalars(
                select(Watchlist)
                .where(Watchlist.profile_id == profile_id)
                .options(selectinload(Watchlist.items))
                .order_by(Watchlist.is_pinned.desc(), Watchlist.sort_order, Watchlist.created_at)
            )
        )

    def get_for_profile(
        self, session: Session, *, profile_id: uuid.UUID, watchlist_id: int
    ) -> Watchlist | None:
        return session.scalar(
            select(Watchlist)
            .where(Watchlist.id == watchlist_id, Watchlist.profile_id == profile_id)
            .options(selectinload(Watchlist.items))
        )


class PositionRepository:
    """Position reads constrained through a portfolio owned by the profile."""

    def list_for_profile(
        self,
        session: Session,
        profile_id: uuid.UUID,
        *,
        open_only: bool = False,
    ) -> list[Position]:
        statement = (
            select(Position)
            .join(Position.portfolio)
            .where(Portfolio.profile_id == profile_id)
            .order_by(Position.is_open.desc(), Position.opened_at.desc(), Position.id.desc())
        )
        if open_only:
            statement = statement.where(Position.is_open.is_(True))
        return list(session.scalars(statement))


class PreferenceRepository:
    """One-to-one user preferences lookup."""

    def get_for_profile(self, session: Session, profile_id: uuid.UUID) -> UserPreference | None:
        return session.get(UserPreference, profile_id)
