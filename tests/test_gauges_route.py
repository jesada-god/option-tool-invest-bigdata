import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.responses import Response

import main


class GaugeRouteTests(unittest.TestCase):
    def test_public_gauges_render_without_cloud_workspace_context(self):
        stats = {
            "indicators": {},
            "ratings": {
                "momentum_rating": {"score": 60, "reasons": []},
                "trend_rating": {"score": 55, "reasons": []},
                "volatility_rating": {"score": 40, "reasons": []},
            },
            "current_iv": 0.3,
            "iv_history": [0.2] * 10,
        }
        with patch("main.stats_engine.analyze_key_statistics", return_value=stats), patch(
            "main.get_cloud_user_or_legacy", side_effect=HTTPException(status_code=503, detail="storage unavailable")
        ), patch("main.get_options_chain_summary", return_value=None):
            result = main.get_gauges(object(), Response(), ticker="NVDA")

        self.assertEqual(result["ticker"], "NVDA")
        self.assertIn("bullish_score", result["gauges"])
        self.assertIn("confidence_score", result["gauges"])
