"""Regression tests for validation at the advanced simulation API boundary."""

from __future__ import annotations

import unittest
from datetime import date, timedelta
from unittest.mock import patch

from pydantic import ValidationError

from main import AdvancedSimulateRequest, SimScenarioModel, SimulatorModel, simulate_advanced


class AdvancedSimulationValidationTests(unittest.TestCase):
    def test_invalid_date_and_non_finite_values_are_rejected_before_simulation(self) -> None:
        with self.assertRaises(ValidationError):
            SimScenarioModel(
                strike_price=100,
                expiration="not-a-date",
                target_date="2030-01-01",
            )

        with self.assertRaises(ValidationError):
            SimulatorModel(
                strike_price=100,
                option_type="CALL",
                expiration="2030-01-01",
                premium_paid=5,
                current_iv=float("inf"),
                target_price=110,
                target_date="2030-01-01",
            )
        with self.assertRaises(ValidationError):
            SimScenarioModel(
                strike_price=float("nan"),
                expiration="2030-01-01",
                target_date="2030-01-01",
            )

    def test_positive_override_is_preserved_in_the_scenario_input(self) -> None:
        target_date = date.today() + timedelta(days=7)
        expiration = date.today() + timedelta(days=30)
        request = AdvancedSimulateRequest(
            ticker="nvda",
            scenarios=[
                SimScenarioModel(
                    strike_price=100,
                    expiration=expiration,
                    target_date=target_date,
                    target_price_override=125.5,
                )
            ],
        )

        with patch("main.get_base_price", return_value=99.0), patch(
            "main.run_multi_scenario", return_value=[]
        ) as run:
            result = simulate_advanced(request)

        self.assertEqual(result["ticker"], "NVDA")
        self.assertEqual(result["underlying_price"], 99.0)
        self.assertEqual(run.call_args.args[0][0].S0, 125.5)
        self.assertEqual(run.call_args.args[0][0].T_days_now, 30)
        self.assertEqual(run.call_args.args[0][0].target_days_from_now, 7)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
