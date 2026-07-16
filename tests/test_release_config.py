import os
import unittest
from unittest.mock import patch

from scripts.validate_production_config import validate


class ReleaseConfigurationTests(unittest.TestCase):
    def test_local_demo_mode_allows_absent_cloud_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(validate(), [])

    def test_production_mode_requires_private_durable_configuration(self):
        with patch.dict(os.environ, {"REQUIRE_PRODUCTION_CONFIG": "true"}, clear=True):
            errors = validate()

        self.assertTrue(any("SUPABASE_URL" in error for error in errors))
        self.assertTrue(any("DATABASE_URL" in error for error in errors))
        self.assertTrue(any("PUBLIC_APP_URL" in error for error in errors))

    def test_complete_https_cloud_configuration_passes_preflight(self):
        environment = {
            "REQUIRE_PRODUCTION_CONFIG": "true",
            "SUPABASE_URL": "https://project.supabase.co",
            "SUPABASE_ANON_KEY": "public-anon-key",
            "PUBLIC_APP_URL": "https://terminal.example",
            "AUTH_COOKIE_SECURE": "true",
            "DATABASE_URL": "postgresql://user:password@db.example/quantora",
            "SUPABASE_GOOGLE_ENABLED": "false",
        }
        with patch.dict(os.environ, environment, clear=True):
            self.assertEqual(validate(), [])
