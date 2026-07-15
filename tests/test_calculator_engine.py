"""Deterministic unit tests for calculator_engine's pure calculation API."""

from __future__ import annotations

import json
import unittest

from calculator_engine import (
    CalculatorValidationError,
    calculate_compound_growth,
    calculate_dca_projection,
    calculate_dcf_fair_value,
    calculate_expected_move,
    calculate_option_intrinsic_value,
    calculate_position_size,
    calculate_probability_above_below,
    normalize_portfolio_allocation,
)


class PositionSizeTests(unittest.TestCase):
    def test_position_size_respects_risk_budget(self) -> None:
        result = calculate_position_size(100_000, 1, 100, 95)

        self.assertEqual(result["recommended_quantity"], 200)
        self.assertEqual(result["max_loss_at_stop"], 1_000.0)
        self.assertEqual(result["position_value"], 20_000.0)
        self.assertFalse(result["is_capped_by_max_position"])

    def test_position_size_caps_narrow_stop_to_maximum_exposure(self) -> None:
        result = calculate_position_size(10_000, 5, 100, 99, max_position_percent=10)

        self.assertEqual(result["unconstrained_quantity"], 500)
        self.assertEqual(result["cap_quantity"], 10)
        self.assertEqual(result["recommended_quantity"], 10)
        self.assertTrue(result["is_capped_by_max_position"])

    def test_position_size_rejects_a_long_stop_above_entry(self) -> None:
        with self.assertRaisesRegex(CalculatorValidationError, "below entry_price"):
            calculate_position_size(10_000, 1, 100, 101)


class GrowthTests(unittest.TestCase):
    def test_compound_growth_with_monthly_end_contributions(self) -> None:
        result = calculate_compound_growth(
            1_000, 12, 1, periodic_contribution=100, compounds_per_year=12
        )

        self.assertEqual(result["periods"], 12)
        self.assertAlmostEqual(result["future_value"], 2_395.075331, places=6)
        self.assertAlmostEqual(result["total_invested"], 2_200.0, places=6)

    def test_dca_projection_is_deterministic_at_zero_return(self) -> None:
        result = calculate_dca_projection(1_000, 100, 0, 1, contributions_per_year=12)

        self.assertEqual(result["future_value"], 2_200.0)
        self.assertEqual(result["total_invested"], 2_200.0)
        self.assertEqual(result["schedule"][-1]["portfolio_value"], 2_200.0)

    def test_growth_rejects_fractional_contribution_periods(self) -> None:
        with self.assertRaisesRegex(CalculatorValidationError, "whole number of contribution periods"):
            calculate_compound_growth(1_000, 8, 0.1, compounds_per_year=12)


class OptionsAndProbabilityTests(unittest.TestCase):
    def test_expected_move_for_one_year_matches_iv(self) -> None:
        result = calculate_expected_move(100, 20, 365)

        self.assertEqual(result["expected_move"], 20.0)
        self.assertEqual(result["lower_bound"], 80.0)
        self.assertEqual(result["upper_bound"], 120.0)

    def test_lognormal_probability_uses_d2_and_complements(self) -> None:
        result = calculate_probability_above_below(100, 100, 20, 365)

        self.assertEqual(result["model"], "risk_neutral_lognormal")
        self.assertAlmostEqual(result["probability_above_percent"], 46.017216, places=6)
        self.assertAlmostEqual(
            result["probability_above_percent"] + result["probability_below_or_equal_percent"],
            100.0,
            places=6,
        )

    def test_zero_volatility_falls_back_to_deterministic_forward(self) -> None:
        result = calculate_probability_above_below(100, 90, 0, 30)

        self.assertEqual(result["model"], "deterministic_forward")
        self.assertEqual(result["probability_above_percent"], 100.0)

    def test_option_intrinsic_value_and_premium_breakdown(self) -> None:
        result = calculate_option_intrinsic_value(
            120, 100, "call", quantity=2, contract_multiplier=100, market_premium_per_share=25
        )

        self.assertEqual(result["intrinsic_per_share"], 20.0)
        self.assertEqual(result["intrinsic_total"], 4_000.0)
        self.assertEqual(result["extrinsic_total"], 1_000.0)
        self.assertFalse(result["premium_below_intrinsic"])


class FairValueAndAllocationTests(unittest.TestCase):
    def test_dcf_fair_value_for_perpetual_flat_cash_flow(self) -> None:
        result = calculate_dcf_fair_value(
            10,
            0,
            10,
            0,
            projection_years=5,
            current_price=80,
        )

        self.assertAlmostEqual(result["fair_value_per_share"], 100.0, places=6)
        self.assertAlmostEqual(result["upside_downside_percent"], 25.0, places=6)
        self.assertEqual(len(result["projected_cash_flows"]), 5)

    def test_dcf_rejects_terminal_growth_at_or_above_discount_rate(self) -> None:
        with self.assertRaisesRegex(CalculatorValidationError, "greater than terminal_growth"):
            calculate_dcf_fair_value(10, 5, 3, 3)

    def test_allocation_normalizes_weights_and_cash_amounts(self) -> None:
        result = normalize_portfolio_allocation({"NVDA": 50, "BND": 30, "CASH": 20}, investment_amount=1_000)

        self.assertEqual(result["total_weight_percent"], 100.0)
        self.assertEqual(result["allocated_amount"], 1_000.0)
        self.assertEqual(result["unallocated_amount"], 0.0)
        self.assertEqual(result["allocations"][0]["amount"], 500.0)

    def test_allocation_rounding_still_totals_100_percent(self) -> None:
        result = normalize_portfolio_allocation({"A": 1, "B": 1, "C": 1})

        self.assertEqual(result["total_weight_percent"], 100.0)
        self.assertEqual(sum(item["weight_percent"] for item in result["allocations"]), 100.0)

    def test_results_are_json_serializable_and_invalid_inputs_are_explicit(self) -> None:
        result = calculate_dcf_fair_value(5, 4, 9, 2, projection_years=3)
        json.dumps(result)

        with self.assertRaisesRegex(CalculatorValidationError, "At least one allocation"):
            normalize_portfolio_allocation({"A": 0, "B": 0})


if __name__ == "__main__":
    unittest.main()
