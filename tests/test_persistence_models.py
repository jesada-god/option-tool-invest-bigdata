import unittest

from app.models import (
    Alert,
    Base,
    Favorite,
    NotificationEvent,
    Portfolio,
    Position,
    Profile,
    RecentViewed,
    SearchHistory,
    SimulationHistory,
    UserPreference,
    Watchlist,
    WatchlistItem,
)
from app.repositories import (
    DEFAULT_PORTFOLIO_NAME,
    DEFAULT_WATCHLIST_NAME,
    PortfolioRepository,
    PositionRepository,
    PreferenceRepository,
    WatchlistRepository,
    _normalize_username,
)


class PersistenceSchemaTests(unittest.TestCase):
    def test_core_tables_are_registered_without_opening_a_database(self):
        self.assertTrue(
            {
                "profiles",
                "user_preferences",
                "portfolios",
                "watchlists",
                "watchlist_items",
                "positions",
                "alerts",
                "notification_events",
                "favorites",
                "search_history",
                "recent_viewed",
                "simulation_history",
            }.issubset(set(Base.metadata.tables))
        )
        self.assertEqual(Profile.__tablename__, "profiles")
        self.assertEqual(UserPreference.__tablename__, "user_preferences")
        self.assertEqual(Portfolio.__tablename__, "portfolios")
        self.assertEqual(Watchlist.__tablename__, "watchlists")
        self.assertEqual(WatchlistItem.__tablename__, "watchlist_items")
        self.assertEqual(Position.__tablename__, "positions")
        self.assertEqual(Alert.__tablename__, "alerts")
        self.assertEqual(NotificationEvent.__tablename__, "notification_events")
        self.assertEqual(Favorite.__tablename__, "favorites")
        self.assertEqual(SearchHistory.__tablename__, "search_history")
        self.assertEqual(RecentViewed.__tablename__, "recent_viewed")
        self.assertEqual(SimulationHistory.__tablename__, "simulation_history")
        self.assertIn("onboarding_completed_at", Profile.__table__.c)

    def test_default_uniqueness_and_high_value_query_indexes_exist(self):
        portfolio_indexes = {index.name for index in Portfolio.__table__.indexes}
        watchlist_indexes = {index.name for index in Watchlist.__table__.indexes}
        position_indexes = {index.name for index in Position.__table__.indexes}
        alert_indexes = {index.name for index in Alert.__table__.indexes}
        notification_indexes = {index.name for index in NotificationEvent.__table__.indexes}

        self.assertIn("uq_portfolios_one_default_per_profile", portfolio_indexes)
        self.assertIn("uq_watchlists_one_default_per_profile", watchlist_indexes)
        self.assertIn("ix_positions_portfolio_open", position_indexes)
        self.assertIn("ix_positions_portfolio_option_opened", position_indexes)
        self.assertIn("ix_positions_ticker", position_indexes)
        self.assertIn("ix_alerts_profile_enabled", alert_indexes)
        self.assertIn("uq_notification_events_profile_dedupe", notification_indexes)

    def test_default_names_and_username_validation_are_deterministic(self):
        self.assertEqual(DEFAULT_PORTFOLIO_NAME, "Main")
        self.assertEqual(DEFAULT_WATCHLIST_NAME, "Watchlist")
        self.assertEqual(_normalize_username("  bas  "), "bas")
        with self.assertRaises(ValueError):
            _normalize_username("ab")

    def test_user_scoped_repository_surface_is_available_without_a_database(self):
        self.assertTrue(callable(PortfolioRepository().get_for_profile))
        self.assertTrue(callable(WatchlistRepository().get_for_profile))
        self.assertTrue(callable(PositionRepository().list_for_profile))
        self.assertTrue(callable(PreferenceRepository().get_for_profile))
