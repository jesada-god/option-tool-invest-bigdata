import unittest

from app.config import (
    PersistenceConfigurationError,
    load_persistence_settings,
    redact_database_url,
)
from app.db import PersistenceNotConfiguredError, create_persistence_engine


class PersistenceConfigurationTests(unittest.TestCase):
    def test_unset_database_url_is_safe_and_does_not_enable_persistence(self):
        settings = load_persistence_settings({})

        self.assertFalse(settings.is_configured)
        with self.assertRaises(PersistenceConfigurationError):
            settings.require_database_url()
        with self.assertRaises(PersistenceNotConfiguredError):
            create_persistence_engine(settings)

    def test_hosted_postgres_url_normalizes_to_psycopg3(self):
        settings = load_persistence_settings(
            {"DATABASE_URL": "postgres://terminal:secret@example.test:5432/portfolio?sslmode=require"}
        )

        self.assertEqual(
            settings.database_url,
            "postgresql+psycopg://terminal:secret@example.test:5432/portfolio?sslmode=require",
        )
        self.assertEqual(
            redact_database_url(settings.database_url),
            "postgresql+psycopg://example.test:5432/portfolio",
        )

    def test_direct_url_is_only_selected_for_migrations(self):
        settings = load_persistence_settings(
            {
                "DATABASE_URL": "postgresql://runtime:secret@runtime.example.test/portfolio",
                "DATABASE_URL_DIRECT": "postgresql://migration:secret@direct.example.test/portfolio",
            }
        )

        self.assertIn("runtime.example.test", settings.require_database_url())
        self.assertIn("direct.example.test", settings.require_migration_database_url())

    def test_non_postgres_url_is_rejected_before_any_connection(self):
        with self.assertRaises(PersistenceConfigurationError):
            load_persistence_settings({"DATABASE_URL": "sqlite:///local.db"})

    def test_invalid_pool_value_is_rejected(self):
        with self.assertRaises(PersistenceConfigurationError):
            load_persistence_settings(
                {"DATABASE_URL": "postgresql://user:pass@example.test/portfolio", "DATABASE_POOL_SIZE": "0"}
            )
