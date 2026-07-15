"""Schema-only coverage for cloud activity additions; no database is opened."""

import unittest

from app.models import Favorite, RecentViewed, SearchHistory, SimulationHistory


class WorkspaceActivitySchemaTests(unittest.TestCase):
    def test_activity_tables_keep_user_scoping_and_recency_indexes(self):
        self.assertIn("uq_favorites_profile_ticker", {item.name for item in Favorite.__table__.constraints})
        self.assertIn("uq_search_history_profile_ticker", {item.name for item in SearchHistory.__table__.constraints})
        self.assertIn("uq_recent_viewed_profile_ticker", {item.name for item in RecentViewed.__table__.constraints})
        self.assertIn("ix_favorites_profile_created", {item.name for item in Favorite.__table__.indexes})
        self.assertIn("ix_search_history_profile_recent", {item.name for item in SearchHistory.__table__.indexes})
        self.assertIn("ix_recent_viewed_profile_recent", {item.name for item in RecentViewed.__table__.indexes})
        self.assertIn("ix_simulation_history_profile_created", {item.name for item in SimulationHistory.__table__.indexes})
