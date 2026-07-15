"""Pure, deterministic investment calculator functions.

The module deliberately has no database, HTTP, market-data, or framework
dependency.  Every function accepts caller-supplied inputs and returns only
JSON-serialisable Python primitives (``dict``, ``list``, ``str``, ``int``,
``float`` and ``None``).  Invalid input raises :class:`CalculatorValidationError`
with a field-specific message so an API layer can translate it into a 422
response without guessing or silently clamping financial inputs.

These calculations are planning tools, not investment advice or a source of
market data.  In particular, the probability calculation is a risk-neutral,
lognormal model; it is not a directional price forecast.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, Literal


OptionType = Literal["CALL", "PUT"]
PositionSide = Literal["LONG", "SHORT"]
ContributionTiming = Literal["begin", "end"]

_ROUND_DIGITS = 6
_MAX_PROJECTION_PERIODS = 100_000


class CalculatorValidationError(ValueError):
    """Raised when a calculator input is invalid or mathematically unsafe."""


def _round(value: float, digits: int = _ROUND_DIGITS) -> float:
    """Return a finite JSON-friendly float and avoid returning negative zero."""
    rounded = round(float(value), digits)
    return 0.0 if rounded == 0 else rounded


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise CalculatorValidationError(f"{field} must be a finite number, not a boolean.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CalculatorValidationError(f"{field} must be a finite number.") from exc
    if not math.isfinite(number):
        raise CalculatorValidationError(f"{field} must be a finite number.")
    return number


def _positive_number(value: Any, field: str) -> float:
    number = _finite_number(value, field)
    if number <= 0:
        raise CalculatorValidationError(f"{field} must be greater than 0.")
    return number


def _non_negative_number(value: Any, field: str) -> float:
    number = _finite_number(value, field)
    if number < 0:
        raise CalculatorValidationError(f"{field} must be greater than or equal to 0.")
    return number


def _positive_integer(value: Any, field: str) -> int:
    number = _positive_number(value, field)
    if not number.is_integer():
        raise CalculatorValidationError(f"{field} must be a whole number.")
    return int(number)


def _non_negative_integer(value: Any, field: str) -> int:
    number = _non_negative_number(value, field)
    if not number.is_integer():
        raise CalculatorValidationError(f"{field} must be a whole number.")
    return int(number)


def _normal_cdf(value: float) -> float:
    """Normal CDF using only the Python standard library."""
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _option_type(value: Any) -> OptionType:
    if not isinstance(value, str):
        raise CalculatorValidationError("option_type must be CALL or PUT.")
    normalized = value.upper().strip()
    if normalized not in {"CALL", "PUT"}:
        raise CalculatorValidationError("option_type must be CALL or PUT.")
    return normalized  # type: ignore[return-value]


def _contribution_timing(value: Any) -> ContributionTiming:
    if not isinstance(value, str):
        raise CalculatorValidationError("contribution_timing must be 'begin' or 'end'.")
    normalized = value.lower().strip()
    if normalized not in {"begin", "end"}:
        raise CalculatorValidationError("contribution_timing must be 'begin' or 'end'.")
    return normalized  # type: ignore[return-value]


def _projection_periods(years: Any, periods_per_year: Any, *, period_field: str) -> tuple[float, int, int]:
    years_number = _non_negative_number(years, "years")
    frequency = _positive_integer(periods_per_year, period_field)
    raw_periods = years_number * frequency
    periods = round(raw_periods)
    if not math.isclose(raw_periods, periods, abs_tol=1e-9):
        raise CalculatorValidationError(
            "years multiplied by "
            f"{period_field} must produce a whole number of contribution periods."
        )
    if periods > _MAX_PROJECTION_PERIODS:
        raise CalculatorValidationError(
            f"projection contains too many periods (maximum {_MAX_PROJECTION_PERIODS})."
        )
    return years_number, frequency, int(periods)


def calculate_position_size(
    account_value: float,
    risk_percent: float,
    entry_price: float,
    stop_price: float,
    *,
    side: PositionSide = "LONG",
    max_position_percent: float = 100.0,
) -> dict[str, Any]:
    """Calculate a whole-unit position size from account risk and a stop.

    The result is capped by ``max_position_percent`` of account value.  This
    prevents a narrow stop from silently producing an unaffordable cash
    position.  A caller that intentionally supports leverage can pass a value
    above 100 explicitly.
    """
    account = _positive_number(account_value, "account_value")
    risk_pct = _positive_number(risk_percent, "risk_percent")
    if risk_pct > 100:
        raise CalculatorValidationError("risk_percent cannot be greater than 100.")
    entry = _positive_number(entry_price, "entry_price")
    stop = _positive_number(stop_price, "stop_price")
    maximum_pct = _positive_number(max_position_percent, "max_position_percent")

    if not isinstance(side, str) or side.upper().strip() not in {"LONG", "SHORT"}:
        raise CalculatorValidationError("side must be LONG or SHORT.")
    normalized_side: PositionSide = side.upper().strip()  # type: ignore[assignment]
    if normalized_side == "LONG" and stop >= entry:
        raise CalculatorValidationError("For LONG positions, stop_price must be below entry_price.")
    if normalized_side == "SHORT" and stop <= entry:
        raise CalculatorValidationError("For SHORT positions, stop_price must be above entry_price.")

    risk_amount = account * risk_pct / 100.0
    risk_per_unit = abs(entry - stop)
    unconstrained_quantity = math.floor(risk_amount / risk_per_unit)
    maximum_position_value = account * maximum_pct / 100.0
    cap_quantity = math.floor(maximum_position_value / entry)
    quantity = max(0, min(unconstrained_quantity, cap_quantity))
    position_value = quantity * entry
    max_loss = quantity * risk_per_unit

    return {
        "side": normalized_side,
        "account_value": _round(account),
        "risk_percent": _round(risk_pct),
        "risk_amount": _round(risk_amount),
        "entry_price": _round(entry),
        "stop_price": _round(stop),
        "risk_per_unit": _round(risk_per_unit),
        "unconstrained_quantity": int(unconstrained_quantity),
        "maximum_position_percent": _round(maximum_pct),
        "maximum_position_value": _round(maximum_position_value),
        "cap_quantity": int(cap_quantity),
        "recommended_quantity": int(quantity),
        "position_value": _round(position_value),
        "position_percent_of_account": _round((position_value / account) * 100.0),
        "max_loss_at_stop": _round(max_loss),
        "risk_budget_used_percent": _round((max_loss / risk_amount) * 100.0) if risk_amount else 0.0,
        "is_capped_by_max_position": bool(unconstrained_quantity > cap_quantity),
    }


def calculate_compound_growth(
    initial_investment: float,
    annual_rate_percent: float,
    years: float,
    *,
    periodic_contribution: float = 0.0,
    compounds_per_year: int = 12,
    contribution_timing: ContributionTiming = "end",
) -> dict[str, Any]:
    """Project compounded growth, optionally with recurring contributions."""
    initial = _non_negative_number(initial_investment, "initial_investment")
    annual_rate = _finite_number(annual_rate_percent, "annual_rate_percent")
    if annual_rate <= -100:
        raise CalculatorValidationError("annual_rate_percent must be greater than -100.")
    contribution = _non_negative_number(periodic_contribution, "periodic_contribution")
    years_number, frequency, periods = _projection_periods(
        years, compounds_per_year, period_field="compounds_per_year"
    )
    timing = _contribution_timing(contribution_timing)

    rate_per_period = (annual_rate / 100.0) / frequency
    growth_factor = (1.0 + rate_per_period) ** periods
    initial_future_value = initial * growth_factor
    if periods == 0 or contribution == 0:
        contribution_future_value = 0.0
    elif math.isclose(rate_per_period, 0.0, abs_tol=1e-15):
        contribution_future_value = contribution * periods
    else:
        annuity_factor = (growth_factor - 1.0) / rate_per_period
        contribution_future_value = contribution * annuity_factor
        if timing == "begin":
            contribution_future_value *= 1.0 + rate_per_period

    future_value = initial_future_value + contribution_future_value
    total_contributions = contribution * periods
    total_invested = initial + total_contributions
    effective_annual_rate = ((1.0 + rate_per_period) ** frequency - 1.0) * 100.0

    return {
        "initial_investment": _round(initial),
        "annual_rate_percent": _round(annual_rate),
        "effective_annual_rate_percent": _round(effective_annual_rate),
        "years": _round(years_number),
        "compounds_per_year": int(frequency),
        "periods": int(periods),
        "periodic_contribution": _round(contribution),
        "contribution_timing": timing,
        "initial_investment_future_value": _round(initial_future_value),
        "contribution_future_value": _round(contribution_future_value),
        "total_contributions": _round(total_contributions),
        "total_invested": _round(total_invested),
        "future_value": _round(future_value),
        "investment_gain": _round(future_value - total_invested),
    }


def calculate_dca_projection(
    initial_investment: float,
    periodic_contribution: float,
    annual_return_percent: float,
    years: float,
    *,
    contributions_per_year: int = 12,
    contribution_timing: ContributionTiming = "end",
) -> dict[str, Any]:
    """Project a periodic DCA plan and return a compact yearly schedule.

    The schedule is calculated iteratively rather than inferred from a
    closed-form formula, making the cash-flow timing explicit and suitable for
    a chart.  It is deterministic and contains no assumed market price path.
    """
    initial = _non_negative_number(initial_investment, "initial_investment")
    contribution = _non_negative_number(periodic_contribution, "periodic_contribution")
    annual_return = _finite_number(annual_return_percent, "annual_return_percent")
    if annual_return <= -100:
        raise CalculatorValidationError("annual_return_percent must be greater than -100.")
    years_number, frequency, periods = _projection_periods(
        years, contributions_per_year, period_field="contributions_per_year"
    )
    timing = _contribution_timing(contribution_timing)
    rate_per_period = (annual_return / 100.0) / frequency

    value = initial
    invested = initial
    schedule: list[dict[str, Any]] = []
    for period in range(1, periods + 1):
        if timing == "begin":
            value += contribution
            invested += contribution
        value *= 1.0 + rate_per_period
        if timing == "end":
            value += contribution
            invested += contribution

        if period % frequency == 0 or period == periods:
            schedule.append(
                {
                    "period": int(period),
                    "year": _round(period / frequency),
                    "portfolio_value": _round(value),
                    "total_invested": _round(invested),
                    "investment_gain": _round(value - invested),
                }
            )

    return {
        "initial_investment": _round(initial),
        "periodic_contribution": _round(contribution),
        "annual_return_percent": _round(annual_return),
        "years": _round(years_number),
        "contributions_per_year": int(frequency),
        "periods": int(periods),
        "contribution_timing": timing,
        "total_contributions": _round(contribution * periods),
        "total_invested": _round(invested),
        "future_value": _round(value),
        "investment_gain": _round(value - invested),
        "schedule": schedule,
    }


def calculate_expected_move(
    price: float,
    implied_volatility_percent: float,
    days: float,
    *,
    days_per_year: float = 365.0,
) -> dict[str, Any]:
    """Calculate the one-standard-deviation price move implied by IV.

    ``days_per_year`` defaults to 365 because option IV convention normally
    uses calendar days.  Callers working strictly with trading days can pass
    252 explicitly.
    """
    underlying_price = _positive_number(price, "price")
    volatility_pct = _non_negative_number(implied_volatility_percent, "implied_volatility_percent")
    day_count = _non_negative_number(days, "days")
    annual_day_count = _positive_number(days_per_year, "days_per_year")

    time_years = day_count / annual_day_count
    volatility = volatility_pct / 100.0
    expected_move = underlying_price * volatility * math.sqrt(time_years)

    return {
        "price": _round(underlying_price),
        "implied_volatility_percent": _round(volatility_pct),
        "days": _round(day_count),
        "days_per_year": _round(annual_day_count),
        "time_years": _round(time_years),
        "standard_deviation": 1,
        "expected_move": _round(expected_move),
        "expected_move_percent": _round((expected_move / underlying_price) * 100.0),
        "lower_bound": _round(max(underlying_price - expected_move, 0.0)),
        "upper_bound": _round(underlying_price + expected_move),
    }


def calculate_probability_above_below(
    spot_price: float,
    target_price: float,
    implied_volatility_percent: float,
    days: float,
    *,
    risk_free_rate_percent: float = 0.0,
    dividend_yield_percent: float = 0.0,
    days_per_year: float = 365.0,
) -> dict[str, Any]:
    """Return risk-neutral lognormal probability of finishing above a target.

    ``probability_below_or_equal_percent`` is the complementary probability,
    so the two values always sum to 100 (subject to display rounding).  It is
    intentionally labelled risk-neutral rather than a prediction.
    """
    spot = _positive_number(spot_price, "spot_price")
    target = _positive_number(target_price, "target_price")
    volatility_pct = _non_negative_number(implied_volatility_percent, "implied_volatility_percent")
    day_count = _non_negative_number(days, "days")
    annual_day_count = _positive_number(days_per_year, "days_per_year")
    risk_free_rate = _finite_number(risk_free_rate_percent, "risk_free_rate_percent") / 100.0
    dividend_yield = _finite_number(dividend_yield_percent, "dividend_yield_percent") / 100.0

    time_years = day_count / annual_day_count
    volatility = volatility_pct / 100.0
    forward_price = spot * math.exp((risk_free_rate - dividend_yield) * time_years)
    standard_deviation = volatility * math.sqrt(time_years)

    if standard_deviation <= 0.0:
        probability_above = 100.0 if forward_price > target else 0.0
        model = "deterministic_forward"
        d2: float | None = None
    else:
        d2 = (
            math.log(spot / target)
            + (risk_free_rate - dividend_yield - 0.5 * volatility * volatility) * time_years
        ) / standard_deviation
        probability_above = _normal_cdf(d2) * 100.0
        model = "risk_neutral_lognormal"

    probability_above = min(max(probability_above, 0.0), 100.0)
    probability_below_or_equal = 100.0 - probability_above
    return {
        "model": model,
        "assumption": "Risk-neutral lognormal distribution; not a directional price forecast.",
        "spot_price": _round(spot),
        "target_price": _round(target),
        "implied_volatility_percent": _round(volatility_pct),
        "days": _round(day_count),
        "days_per_year": _round(annual_day_count),
        "time_years": _round(time_years),
        "risk_free_rate_percent": _round(risk_free_rate * 100.0),
        "dividend_yield_percent": _round(dividend_yield * 100.0),
        "forward_price": _round(forward_price),
        "d2": _round(d2) if d2 is not None else None,
        "probability_above_percent": _round(probability_above),
        "probability_below_or_equal_percent": _round(probability_below_or_equal),
    }


def calculate_option_intrinsic_value(
    spot_price: float,
    strike_price: float,
    option_type: OptionType,
    *,
    quantity: int = 1,
    contract_multiplier: int = 100,
    market_premium_per_share: float | None = None,
) -> dict[str, Any]:
    """Calculate option intrinsic value without fetching an option chain."""
    spot = _non_negative_number(spot_price, "spot_price")
    strike = _positive_number(strike_price, "strike_price")
    option = _option_type(option_type)
    contracts = _non_negative_integer(quantity, "quantity")
    multiplier = _positive_integer(contract_multiplier, "contract_multiplier")
    premium = (
        None
        if market_premium_per_share is None
        else _non_negative_number(market_premium_per_share, "market_premium_per_share")
    )

    intrinsic_per_share = max(spot - strike, 0.0) if option == "CALL" else max(strike - spot, 0.0)
    result: dict[str, Any] = {
        "option_type": option,
        "spot_price": _round(spot),
        "strike_price": _round(strike),
        "quantity": int(contracts),
        "contract_multiplier": int(multiplier),
        "intrinsic_per_share": _round(intrinsic_per_share),
        "intrinsic_total": _round(intrinsic_per_share * contracts * multiplier),
    }
    if premium is not None:
        market_value_total = premium * contracts * multiplier
        result.update(
            {
                "market_premium_per_share": _round(premium),
                "market_value_total": _round(market_value_total),
                "extrinsic_per_share": _round(premium - intrinsic_per_share),
                "extrinsic_total": _round((premium - intrinsic_per_share) * contracts * multiplier),
                "premium_below_intrinsic": bool(premium < intrinsic_per_share),
            }
        )
    return result

def calculate_dcf_fair_value(
    free_cash_flow_per_share: float,
    growth_rate_percent: float,
    discount_rate_percent: float,
    terminal_growth_rate_percent: float,
    *,
    projection_years: int = 5,
    current_price: float | None = None,
    margin_of_safety_percent: float = 0.0,
) -> dict[str, Any]:
    """Calculate a per-share DCF fair value from explicit caller inputs.

    This is a two-stage constant-growth model: an explicit growth period plus
    a Gordon-growth terminal value.  It deliberately requires caller-supplied
    cash flow and rates rather than inventing fundamental data.
    """
    base_fcf = _positive_number(free_cash_flow_per_share, "free_cash_flow_per_share")
    growth_rate = _finite_number(growth_rate_percent, "growth_rate_percent") / 100.0
    discount_rate = _finite_number(discount_rate_percent, "discount_rate_percent") / 100.0
    terminal_growth_rate = (
        _finite_number(terminal_growth_rate_percent, "terminal_growth_rate_percent") / 100.0
    )
    if growth_rate <= -1.0:
        raise CalculatorValidationError("growth_rate_percent must be greater than -100.")
    if discount_rate <= -1.0:
        raise CalculatorValidationError("discount_rate_percent must be greater than -100.")
    if terminal_growth_rate <= -1.0:
        raise CalculatorValidationError("terminal_growth_rate_percent must be greater than -100.")
    if discount_rate <= terminal_growth_rate:
        raise CalculatorValidationError(
            "discount_rate_percent must be greater than terminal_growth_rate_percent."
        )
    years = _positive_integer(projection_years, "projection_years")
    safety_margin = _non_negative_number(margin_of_safety_percent, "margin_of_safety_percent")
    if safety_margin >= 100:
        raise CalculatorValidationError("margin_of_safety_percent must be less than 100.")
    market_price = None if current_price is None else _positive_number(current_price, "current_price")

    projected_cash_flows: list[dict[str, Any]] = []
    explicit_present_value = 0.0
    for year in range(1, years + 1):
        cash_flow = base_fcf * ((1.0 + growth_rate) ** year)
        present_value = cash_flow / ((1.0 + discount_rate) ** year)
        explicit_present_value += present_value
        projected_cash_flows.append(
            {
                "year": int(year),
                "free_cash_flow_per_share": _round(cash_flow),
                "present_value": _round(present_value),
            }
        )

    terminal_year_cash_flow = base_fcf * ((1.0 + growth_rate) ** years)
    terminal_value = terminal_year_cash_flow * (1.0 + terminal_growth_rate) / (
        discount_rate - terminal_growth_rate
    )
    terminal_present_value = terminal_value / ((1.0 + discount_rate) ** years)
    fair_value = explicit_present_value + terminal_present_value
    value_after_margin_of_safety = fair_value * (1.0 - safety_margin / 100.0)

    result: dict[str, Any] = {
        "model": "two_stage_dcf",
        "free_cash_flow_per_share": _round(base_fcf),
        "growth_rate_percent": _round(growth_rate * 100.0),
        "discount_rate_percent": _round(discount_rate * 100.0),
        "terminal_growth_rate_percent": _round(terminal_growth_rate * 100.0),
        "projection_years": int(years),
        "projected_cash_flows": projected_cash_flows,
        "explicit_present_value": _round(explicit_present_value),
        "terminal_value": _round(terminal_value),
        "terminal_present_value": _round(terminal_present_value),
        "fair_value_per_share": _round(fair_value),
        "margin_of_safety_percent": _round(safety_margin),
        "value_after_margin_of_safety": _round(value_after_margin_of_safety),
    }
    if market_price is not None:
        result["current_price"] = _round(market_price)
        result["upside_downside_percent"] = _round(((fair_value / market_price) - 1.0) * 100.0)
        result["margin_of_safety_upside_downside_percent"] = _round(
            ((value_after_margin_of_safety / market_price) - 1.0) * 100.0
        )
    return result


def normalize_portfolio_allocation(
    allocations: Mapping[str, float],
    *,
    investment_amount: float | None = None,
) -> dict[str, Any]:
    """Normalize non-negative allocation weights to exactly 100 percent.

    ``allocations`` can contain percentages, ratios, or arbitrary positive
    weights.  If ``investment_amount`` is supplied, the normalized dollar
    amounts are included and rounded so their sum equals the input exactly to
    the cent.
    """
    if not isinstance(allocations, Mapping) or not allocations:
        raise CalculatorValidationError("allocations must be a non-empty mapping of asset names to weights.")

    parsed: list[tuple[str, float]] = []
    for asset, weight in allocations.items():
        if not isinstance(asset, str) or not asset.strip():
            raise CalculatorValidationError("Each allocation asset name must be a non-empty string.")
        parsed.append((asset.strip(), _non_negative_number(weight, f"allocation weight for {asset!r}")))

    total_weight = sum(weight for _, weight in parsed)
    if total_weight <= 0:
        raise CalculatorValidationError("At least one allocation weight must be greater than 0.")
    amount = None if investment_amount is None else _non_negative_number(investment_amount, "investment_amount")

    normalized_weights = [_round((weight / total_weight) * 100.0) for _, weight in parsed]
    # Correct display rounding on the final item so consumers can safely show a
    # total of exactly 100.000000 without a floating-point residue.
    normalized_weights[-1] = _round(100.0 - sum(normalized_weights[:-1]))

    normalized_amounts: list[float] | None = None
    if amount is not None:
        normalized_amounts = [round(amount * weight / 100.0, 2) for weight in normalized_weights]
        normalized_amounts[-1] = round(amount - sum(normalized_amounts[:-1]), 2)

    items: list[dict[str, Any]] = []
    for index, ((asset, input_weight), weight_percent) in enumerate(zip(parsed, normalized_weights)):
        item: dict[str, Any] = {
            "asset": asset,
            "input_weight": _round(input_weight),
            "weight_percent": _round(weight_percent),
        }
        if normalized_amounts is not None:
            item["amount"] = normalized_amounts[index]
        items.append(item)

    result: dict[str, Any] = {
        "total_input_weight": _round(total_weight),
        "total_weight_percent": _round(sum(item["weight_percent"] for item in items)),
        "normalization_applied": not math.isclose(total_weight, 100.0, abs_tol=1e-9),
        "allocations": items,
    }
    if amount is not None:
        result["investment_amount"] = round(amount, 2)
        result["allocated_amount"] = round(sum(item["amount"] for item in items), 2)
        result["unallocated_amount"] = round(amount - result["allocated_amount"], 2)
    return result
