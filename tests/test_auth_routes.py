import uuid
import unittest
from unittest.mock import patch

from starlette.requests import Request
from starlette.responses import Response

import main
from app.auth import AuthSettings, CurrentUser, CSRF_COOKIE, REFRESH_COOKIE


def request_with_cookies(*, refresh_token="refresh-token", csrf_token="csrf-token"):
    return Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "path": "/api/auth/refresh",
            "query_string": b"",
            "headers": [
                (b"origin", b"https://terminal.example"),
                (b"x-csrf-token", csrf_token.encode("ascii")),
                (b"cookie", f"{REFRESH_COOKIE}={refresh_token}; {CSRF_COOKIE}={csrf_token}".encode("ascii")),
            ],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 443),
        }
    )


class AuthRouteTests(unittest.TestCase):
    def setUp(self):
        self.settings = AuthSettings(
            supabase_url="https://project.supabase.co",
            anon_key="anon-key",
            public_app_url="https://terminal.example",
            google_enabled=True,
            secure_cookies=True,
            timeout_seconds=10,
            oauth_state_secret="x" * 32,
            oauth_transaction_ttl_seconds=600,
        )

    def test_refresh_route_rotates_cookie_without_exposing_tokens(self):
        session = {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}
        user = CurrentUser(id=uuid.uuid4(), email="user@example.com", metadata={}, raw={})
        response = Response()
        with patch("main.get_runtime_auth_settings", return_value=self.settings), patch(
            "main.coordinated_refresh_session", return_value=session
        ) as refresh, patch("main.get_user_from_access_token", return_value=user):
            result = main.refresh_auth_session(request_with_cookies(), response)

        self.assertTrue(result["authenticated"])
        self.assertEqual(result["user"]["email"], "user@example.com")
        self.assertNotIn("access_token", result)
        self.assertNotIn("refresh_token", result)
        refresh.assert_called_once_with("refresh-token", self.settings)

    def test_documented_auth_compatibility_routes_exist(self):
        paths = {route.path for route in main.app.routes}
        for path in (
            "/api/auth/register", "/api/auth/login", "/api/auth/logout",
            "/api/auth/me", "/api/auth/refresh", "/api/auth/verify-email",
        ):
            self.assertIn(path, paths)

    def test_option_position_routes_include_editing(self):
        routes = {(route.path, method) for route in main.app.routes for method in getattr(route, "methods", set())}
        self.assertIn(("/api/positions", "POST"), routes)
        self.assertIn(("/api/positions/{pos_id}", "PATCH"), routes)

    def test_me_bootstraps_csrf_for_an_existing_authenticated_session(self):
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "scheme": "https",
                "path": "/api/auth/me",
                "query_string": b"",
                "headers": [(b"host", b"terminal.example")],
                "client": ("127.0.0.1", 12345),
                "server": ("terminal.example", 443),
            }
        )
        response = Response()
        user = CurrentUser(id=uuid.uuid4(), email="user@example.com", metadata={}, raw={})
        with patch("main.get_runtime_auth_settings", return_value=self.settings), patch(
            "main.auth_runtime_is_available", return_value=True
        ), patch("main.google_callback_is_available", return_value=False), patch(
            "main.get_optional_current_user", return_value=user
        ), patch("main.persistence_is_configured", return_value=False):
            result = main.get_me(request, response)

        self.assertTrue(result["authenticated"])
        self.assertTrue(result["csrf_token"])
        self.assertEqual(result["csrf_token"], response.headers["X-CSRF-Token"])
