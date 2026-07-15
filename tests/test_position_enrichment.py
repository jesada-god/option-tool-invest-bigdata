import unittest
from unittest.mock import patch

import main


class PositionEnrichmentTests(unittest.TestCase):
    def test_successful_valuation_returns_the_position_payload(self):
        """Regression test for the open-contract UI receiving JSON null."""
        position = {
            "id": 1,
            "ticker": "NVDA",
            "strike_price": 100,
            "option_type": "CALL",
            "expiration": "2030-01-01",
            "premium_paid": 2.5,
            "quantity": 1,
            "iv": 30,
            "delta": 0.5,
            "entry_underlying_price": 100,
        }
        with patch("main.get_base_price", return_value=110), patch(
            "main.yf.Ticker", side_effect=RuntimeError("option chain unavailable")
        ):
            result = main.enrich_option_position(position)

        self.assertIsInstance(result, dict)
        self.assertEqual(result["id"], 1)
        self.assertEqual(result["ticker"], "NVDA")
        self.assertIn("pnl", result)
        self.assertFalse(result["market_data_stale"])
