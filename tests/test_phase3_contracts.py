"""Phase 3 regressions for resilient, backward-compatible API contracts."""

from __future__ import annotations

import asyncio
import unittest
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

import main


def request_with_cookie(cookie: str = "") -> Request:
    headers = [(b"cookie", cookie.encode("latin-1"))] if cookie else []
    return Request(
        {
            "type": "http", "method": "GET", "scheme": "https", "path": "/api/positions",
            "query_string": b"", "headers": headers, "client": ("127.0.0.1", 12345),
            "server": ("testserver", 443),
        }
    )


class Phase3ContractTests(unittest.TestCase):
    def test_demo_workspace_isolated_and_uses_monotonic_position_ids(self) -> None:
        main.demo_workspaces.clear()
        first_response = Response()
        settings = SimpleNamespace(secure_cookies=True)
        with patch("main.get_runtime_auth_settings", return_value=settings):
            first = main.get_demo_workspace(request_with_cookie(), first_response)
        session_id = first_response.headers["set-cookie"].split(";", 1)[0].split("=", 1)[1]
        with patch("main.get_runtime_auth_settings", return_value=settings):
            same_browser = main.get_demo_workspace(
                request_with_cookie(f"{main.DEMO_SESSION_COOKIE}={session_id}"), Response()
            )
            other_browser = main.get_demo_workspace(request_with_cookie(), Response())

        first["watchlist"].append("MSFT")
        first["positions"].append({"id": first["next_position_id"], "ticker": "MSFT"})
        first["next_position_id"] += 1
        first["positions"].append({"id": first["next_position_id"], "ticker": "AMD"})

        self.assertIs(first, same_browser)
        self.assertEqual([item["id"] for item in first["positions"]], [1, 2])
        self.assertNotIn("MSFT", other_browser["watchlist"])
        self.assertEqual(other_browser["positions"], [])

    def test_market_failures_keep_their_documented_response_types(self) -> None:
        with patch("main.get_raw_history", return_value=None):
            chart = main._get_chart_data("NVDA", "1d")
        self.assertEqual(chart, [])
        self.assertIsInstance(chart, list)

        with patch("main.yf.Ticker", side_effect=RuntimeError("provider down")):
            stats = main._get_stats("NVDA")
        self.assertEqual(stats["ticker"], "NVDA")
        self.assertEqual(stats["status"], "unavailable")
        self.assertIn("current_price", stats)
        self.assertNotIn("data", stats)

        async def timed_out_chart() -> list[dict[str, object]]:
            with patch("main.run_bounded_market_call", side_effect=asyncio.TimeoutError):
                return await main.get_chart_data("NVDA", "1d")

        self.assertEqual(asyncio.run(timed_out_chart()), [])

    def test_portfolio_greeks_degrades_without_shared_legacy_positions(self) -> None:
        with patch("main.get_position_source", return_value=[{"ticker": "NVDA"}]) as source, patch(
            "main.portfolio_engine.compute_portfolio_greeks", side_effect=RuntimeError("quote down")
        ):
            payload = main.get_portfolio_greeks(request_with_cookie(), Response())

        source.assert_called_once()
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["positions"], [])
        self.assertEqual(payload["position_count"], 0)

    def test_simulator_rejects_target_dates_after_expiration_with_422(self) -> None:
        model = main.SimulatorModel(
            strike_price=100,
            option_type="CALL",
            expiration=date.today() + timedelta(days=7),
            premium_paid=5,
            current_iv=30,
            target_price=105,
            target_date=date.today() + timedelta(days=8),
        )
        with self.assertRaises(HTTPException) as raised:
            main.simulate_option(model)
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Target date", raised.exception.detail)

    def test_calculator_input_shape_errors_are_422_not_500(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            main.run_calculator(lambda required: {"required": required}, {"unknown": 1})
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Invalid calculator inputs", raised.exception.detail)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
