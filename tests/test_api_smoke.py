"""Fast, deterministic HTTP smoke coverage for public production surfaces."""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

import main
from rate_limit import SlidingWindowRateLimiter


class ApiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(main.app, base_url="https://testserver")

    def test_health_and_security_headers(self) -> None:
        response = self.client.get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertEqual(response.headers["cross-origin-opener-policy"], "same-origin")
        self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin")
        self.assertIn("max-age=31536000", response.headers["strict-transport-security"])
        csp = response.headers["content-security-policy"]
        self.assertIn("script-src 'self';", csp)
        self.assertIn("img-src 'self' data:;", csp)
        self.assertNotIn("https://", csp)
        self.assertIn("script-src-attr 'unsafe-inline'", csp)
        self.assertIn("worker-src 'self'", csp)

    def test_search_and_legacy_portfolio_surfaces_are_available(self) -> None:
        search = self.client.get("/api/search", params={"q": "GOOG", "limit": 3})
        positions = self.client.get("/api/positions")

        self.assertEqual(search.status_code, 200)
        self.assertLessEqual(len(search.json()["items"]), 3)
        self.assertIn("GOOGL", [item["symbol"] for item in search.json()["items"]])
        self.assertEqual(positions.status_code, 200)
        self.assertIsInstance(positions.json(), list)

    def test_frontend_routes_degrade_cleanly_without_a_local_build(self) -> None:
        response = self.client.get("/watchlist")
        self.assertIn(response.status_code, {200, 503})

    def test_cross_origin_request_does_not_receive_cors_permission(self) -> None:
        response = self.client.get("/healthz", headers={"Origin": "https://attacker.example"})

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_auth_rate_limit_rejects_excess_requests_before_handler_work(self) -> None:
        original_limiter = main.auth_rate_limiter
        original_limit = main.AUTH_RATE_LIMIT_PER_MINUTE
        main.auth_rate_limiter = SlidingWindowRateLimiter()
        main.AUTH_RATE_LIMIT_PER_MINUTE = 2
        try:
            first = self.client.post("/api/auth/sign-in", json={})
            second = self.client.post("/api/auth/sign-in", json={})
            limited = self.client.post("/api/auth/sign-in", json={})
        finally:
            main.auth_rate_limiter = original_limiter
            main.AUTH_RATE_LIMIT_PER_MINUTE = original_limit

        self.assertEqual(first.status_code, 422)
        self.assertEqual(second.status_code, 422)
        self.assertEqual(limited.status_code, 429)
        self.assertIn("retry-after", limited.headers)
