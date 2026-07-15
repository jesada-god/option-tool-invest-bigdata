"""No-database unit coverage for cloud workspace CRUD service boundaries."""

from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

from app.cloud_service import (
    CloudResourceNotFoundError,
    CloudServiceValidationError,
    DefaultResourceProtectionError,
    add_watchlist_item,
    archive_portfolio,
    create_portfolio,
    create_watchlist,
    delete_watchlist,
    normalize_portfolio_currency,
    normalize_portfolio_name,
    normalize_sort_order,
    normalize_watchlist_name,
    normalize_watchlist_ticker,
    portfolio_payload,
    rename_portfolio,
    remove_watchlist_item,
    reorder_watchlist_items,
    update_watchlist,
    watchlist_payload,
)
from app.models import Portfolio, Watchlist, WatchlistItem


class _FakeSession:
    """The service only needs these unit-of-work methods in the tests below."""

    def __init__(self) -> None:
        self.added: list[object] = []
        self.deleted: list[object] = []
        self.flush_count = 0
        self.scalar_results: list[object | None] = []

    def add(self, value: object) -> None:
        self.added.append(value)

    def delete(self, value: object) -> None:
        self.deleted.append(value)

    def flush(self) -> None:
        self.flush_count += 1

    def scalar(self, _statement: object) -> object | None:
        return self.scalar_results.pop(0) if self.scalar_results else None


class _WatchlistRepositoryStub:
    def __init__(self, watchlist: Watchlist | None) -> None:
        self.watchlist = watchlist
        self.calls: list[tuple[uuid.UUID, int]] = []

    def get_for_profile(
        self, _session: object, *, profile_id: uuid.UUID, watchlist_id: int
    ) -> Watchlist | None:
        self.calls.append((profile_id, watchlist_id))
        return self.watchlist


class _PortfolioRepositoryStub:
    def __init__(self, portfolio: Portfolio | None) -> None:
        self.portfolio = portfolio

    def get_for_profile(
        self, _session: object, *, profile_id: uuid.UUID, portfolio_id: int
    ) -> Portfolio | None:
        return self.portfolio


def _watchlist(profile_id: uuid.UUID, *, is_default: bool = False) -> Watchlist:
    return Watchlist(
        id=55,
        profile_id=profile_id,
        name="Technology",
        is_default=is_default,
        is_favorite=False,
        is_pinned=False,
        sort_order=2,
    )


class CloudWorkspaceValidationTests(unittest.TestCase):
    def test_resource_names_tickers_currency_and_sort_order_are_normalized(self) -> None:
        self.assertEqual(normalize_portfolio_name("  Growth  "), "Growth")
        self.assertEqual(normalize_watchlist_name("  Semiconductors "), "Semiconductors")
        self.assertEqual(normalize_watchlist_ticker(" brk.b "), "BRK.B")
        self.assertEqual(normalize_watchlist_ticker("btc-usd"), "BTC-USD")
        self.assertEqual(normalize_portfolio_currency(" thb "), "THB")
        self.assertEqual(normalize_sort_order(0), 0)

        with self.assertRaisesRegex(CloudServiceValidationError, "name is required"):
            normalize_portfolio_name("   ")
        with self.assertRaisesRegex(CloudServiceValidationError, "at most 80"):
            normalize_watchlist_name("x" * 81)
        with self.assertRaisesRegex(CloudServiceValidationError, "ticker"):
            normalize_watchlist_ticker("NV DA")
        with self.assertRaisesRegex(CloudServiceValidationError, "three-letter"):
            normalize_portfolio_currency("US")
        with self.assertRaisesRegex(CloudServiceValidationError, "sort_order"):
            normalize_sort_order(True)

    def test_creation_helpers_validate_and_build_non_default_resources_without_a_database(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        portfolio = create_portfolio(
            session,
            profile_id=profile_id,
            name=" Dividend ",
            currency="usd",
        )
        watchlist = create_watchlist(
            session,
            profile_id=profile_id,
            name=" Income ",
            is_favorite=True,
            is_pinned=True,
        )

        self.assertEqual(portfolio.name, "Dividend")
        self.assertEqual(portfolio.currency, "USD")
        self.assertFalse(portfolio.is_default)
        self.assertEqual(watchlist.name, "Income")
        self.assertTrue(watchlist.is_favorite)
        self.assertTrue(watchlist.is_pinned)
        self.assertFalse(watchlist.is_default)
        self.assertEqual(session.flush_count, 2)

    def test_payloads_are_json_ready_without_loading_a_database(self) -> None:
        profile_id = uuid.uuid4()
        now = datetime(2026, 7, 15, 8, 30, tzinfo=timezone.utc)
        portfolio = Portfolio(
            id=7,
            profile_id=profile_id,
            name="Growth",
            currency="USD",
            is_default=False,
            sort_order=1,
            created_at=now,
            updated_at=now,
        )
        watchlist = _watchlist(profile_id)
        watchlist.created_at = now
        watchlist.updated_at = now
        watchlist.items = [
            WatchlistItem(id=12, watchlist_id=55, ticker="NVDA", sort_order=0, added_at=now)
        ]

        self.assertEqual(portfolio_payload(portfolio)["id"], 7)
        payload = watchlist_payload(watchlist, include_items=True)
        self.assertEqual(payload["name"], "Technology")
        self.assertEqual(
            payload["items"],
            [{"id": 12, "ticker": "NVDA", "sort_order": 0, "added_at": now.isoformat()}],
        )


class CloudWorkspaceOwnershipAndOrderingTests(unittest.TestCase):
    def test_update_and_delete_use_a_profile_scoped_repository(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        watchlist = _watchlist(profile_id)
        repository = _WatchlistRepositoryStub(watchlist)
        with patch("app.cloud_service.WatchlistRepository", return_value=repository):
            result = update_watchlist(
                session,
                profile_id=profile_id,
                watchlist_id=55,
                name="AI Leaders",
                is_favorite=True,
                is_pinned=True,
                sort_order=4,
            )

        self.assertIs(result, watchlist)
        self.assertEqual(repository.calls, [(profile_id, 55)])
        self.assertEqual(watchlist.name, "AI Leaders")
        self.assertTrue(watchlist.is_favorite)
        self.assertTrue(watchlist.is_pinned)
        self.assertEqual(watchlist.sort_order, 4)
        self.assertEqual(session.flush_count, 1)

    def test_default_watchlist_and_portfolio_are_protected(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        default_watchlist = _watchlist(profile_id, is_default=True)
        default_portfolio = Portfolio(
            id=6,
            profile_id=profile_id,
            name="Main",
            currency="USD",
            is_default=True,
            sort_order=0,
        )
        with patch(
            "app.cloud_service.WatchlistRepository",
            return_value=_WatchlistRepositoryStub(default_watchlist),
        ), patch(
            "app.cloud_service.PortfolioRepository",
            return_value=_PortfolioRepositoryStub(default_portfolio),
        ):
            with self.assertRaises(DefaultResourceProtectionError):
                delete_watchlist(session, profile_id=profile_id, watchlist_id=55)
            with self.assertRaises(DefaultResourceProtectionError):
                archive_portfolio(session, profile_id=profile_id, portfolio_id=6)

        self.assertEqual(session.deleted, [])
        self.assertEqual(session.flush_count, 0)

    def test_rename_and_archive_only_mutate_an_owned_active_portfolio(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        portfolio = Portfolio(
            id=6,
            profile_id=profile_id,
            name="Growth",
            currency="USD",
            is_default=False,
            sort_order=1,
        )
        archived_at = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)
        with patch(
            "app.cloud_service.PortfolioRepository",
            return_value=_PortfolioRepositoryStub(portfolio),
        ):
            renamed = rename_portfolio(
                session,
                profile_id=profile_id,
                portfolio_id=6,
                name=" Long Term Growth ",
            )
            archived = archive_portfolio(
                session,
                profile_id=profile_id,
                portfolio_id=6,
                archived_at=archived_at,
            )

        self.assertIs(renamed, portfolio)
        self.assertIs(archived, portfolio)
        self.assertEqual(portfolio.name, "Long Term Growth")
        self.assertEqual(portfolio.archived_at, archived_at)
        self.assertEqual(session.flush_count, 2)

    def test_missing_owned_resource_is_not_mutated(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        with patch(
            "app.cloud_service.WatchlistRepository",
            return_value=_WatchlistRepositoryStub(None),
        ):
            with self.assertRaises(CloudResourceNotFoundError):
                delete_watchlist(session, profile_id=profile_id, watchlist_id=99)
        self.assertEqual(session.deleted, [])

    def test_item_reorder_requires_the_complete_set_and_resequences(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        watchlist = _watchlist(profile_id)
        watchlist.items = [
            WatchlistItem(id=11, watchlist_id=55, ticker="NVDA", sort_order=0),
            WatchlistItem(id=22, watchlist_id=55, ticker="AMD", sort_order=1),
            WatchlistItem(id=33, watchlist_id=55, ticker="TSM", sort_order=2),
        ]
        with patch(
            "app.cloud_service.WatchlistRepository",
            return_value=_WatchlistRepositoryStub(watchlist),
        ):
            with self.assertRaisesRegex(CloudServiceValidationError, "every current item"):
                reorder_watchlist_items(
                    session,
                    profile_id=profile_id,
                    watchlist_id=55,
                    item_ids=[33, 11],
                )
            ordered = reorder_watchlist_items(
                session,
                profile_id=profile_id,
                watchlist_id=55,
                item_ids=[33, 11, 22],
            )

        self.assertEqual([item.ticker for item in ordered], ["TSM", "NVDA", "AMD"])
        self.assertEqual([item.sort_order for item in ordered], [0, 1, 2])
        self.assertEqual(session.flush_count, 1)

    def test_item_add_is_idempotent_and_remove_resequences(self) -> None:
        profile_id = uuid.uuid4()
        session = _FakeSession()
        watchlist = _watchlist(profile_id)
        first = WatchlistItem(id=11, watchlist_id=55, ticker="NVDA", sort_order=0)
        second = WatchlistItem(id=22, watchlist_id=55, ticker="AMD", sort_order=1)
        watchlist.items = [first, second]
        with patch(
            "app.cloud_service.WatchlistRepository",
            return_value=_WatchlistRepositoryStub(watchlist),
        ):
            existing = add_watchlist_item(
                session,
                profile_id=profile_id,
                watchlist_id=55,
                ticker=" nvda ",
            )
            added = add_watchlist_item(
                session,
                profile_id=profile_id,
                watchlist_id=55,
                ticker="TSM",
                sort_order=1,
            )
            removed = remove_watchlist_item(
                session,
                profile_id=profile_id,
                watchlist_id=55,
                ticker="NVDA",
            )

        self.assertIs(existing, first)
        self.assertIs(removed, first)
        self.assertEqual(added.ticker, "TSM")
        self.assertEqual([item.ticker for item in watchlist.items], ["TSM", "AMD"])
        self.assertEqual([item.sort_order for item in watchlist.items], [0, 1])
        self.assertEqual(session.deleted, [first])
        self.assertEqual(session.flush_count, 2)


if __name__ == "__main__":
    unittest.main()
