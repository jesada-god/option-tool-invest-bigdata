"""
portfolio_engine.py
====================
Phase 2 (partial) — Real-Time Portfolio Greeks.

Given the app's `logged_positions` list (ticker, strike, option_type,
expiration, premium_paid, quantity, iv) plus each underlying's live
price, computes per-position Greeks (via pricing_engine.black_scholes)
and the portfolio-level aggregates that gauges_engine.py needs:

    net_delta, net_gamma, net_theta ($/day), net_vega ($/vol-pt), net_rho,
    plus per-position breakdown, total capital at risk, and basic
    concentration (% of risk in the single largest position).

This intentionally does not try to replicate the entire 60-field
portfolio wishlist from the original spec — it focuses on the Greeks
aggregation gauges_engine.py actually consumes (net_theta, net_vega,
net_gamma) so the "Options Gauges" panel can show real numbers instead
of "N/A" whenever the user has open positions.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable, Optional

from pricing_engine import black_scholes


def compute_portfolio_greeks(positions: list[dict], get_underlying_price: Callable[[str], float],
                              r: float = 0.05, contract_multiplier: int = 100) -> dict:
    """
    positions: list of dicts shaped like the app's logged_positions
               (ticker, strike_price, option_type, expiration, premium_paid, quantity, iv)
    get_underlying_price: fn(ticker) -> current underlying price
    """
    if not positions:
        return {
            "net_delta": None, "net_gamma": None, "net_theta": None, "net_vega": None, "net_rho": None,
            "positions": [], "total_capital_at_risk": 0.0, "largest_position_pct": 0.0,
            "position_count": 0,
        }

    net_delta = net_gamma = net_theta = net_vega = net_rho = 0.0
    total_capital = 0.0
    per_position = []

    for pos in positions:
        try:
            ticker = pos["ticker"]
            K = float(pos["strike_price"])
            option_type = pos["option_type"].upper()
            qty = int(pos["quantity"])
            iv = float(pos.get("iv", 0.0)) / 100.0
            premium_paid = float(pos.get("premium_paid", 0.0))
            exp = pos["expiration"]

            S = get_underlying_price(ticker)
            days_left = max((datetime.strptime(exp, "%Y-%m-%d") - datetime.now()).days, 0)
            T = days_left / 365.0
            sigma = iv if iv > 0 else 0.30   # fall back to a generic 30% IV if not supplied

            bs = black_scholes(S, K, T, r, sigma, 0.0, option_type)

            # dollarized, signed by contract quantity/multiplier (long options = positive qty)
            pos_delta = bs.delta * qty * contract_multiplier
            pos_gamma = bs.gamma * qty * contract_multiplier
            pos_theta = bs.theta * qty * contract_multiplier   # $/day
            pos_vega = bs.vega * qty * contract_multiplier      # $ per 1 vol POINT (BSResult convention)
            pos_rho = bs.rho * qty * contract_multiplier

            capital = abs(premium_paid) * abs(qty) * contract_multiplier

            net_delta += pos_delta
            net_gamma += pos_gamma
            net_theta += pos_theta
            net_vega += pos_vega
            net_rho += pos_rho
            total_capital += capital

            per_position.append({
                "ticker": ticker, "strike": K, "option_type": option_type, "quantity": qty,
                "delta": round(pos_delta, 2), "gamma": round(pos_gamma, 4),
                "theta_per_day": round(pos_theta, 2), "vega": round(pos_vega, 2), "rho": round(pos_rho, 2),
                "capital_at_risk": round(capital, 2),
                "days_to_expiration": days_left,
                "intrinsic_value": round(bs.intrinsic * qty * contract_multiplier, 2),
                "extrinsic_value": round(bs.extrinsic * qty * contract_multiplier, 2),
            })
        except Exception:
            continue

    largest = max((p["capital_at_risk"] for p in per_position), default=0.0)
    largest_pct = round((largest / total_capital * 100) if total_capital else 0.0, 1)

    return {
        "net_delta": round(net_delta, 2), "net_gamma": round(net_gamma, 4),
        "net_theta": round(net_theta, 2), "net_vega": round(net_vega, 2), "net_rho": round(net_rho, 2),
        "positions": per_position,
        "total_capital_at_risk": round(total_capital, 2),
        "largest_position_pct": largest_pct,
        "position_count": len(per_position),
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    fake_positions = [
        {"ticker": "NVDA", "strike_price": 140, "option_type": "CALL",
         "expiration": "2026-09-19", "premium_paid": 5.2, "quantity": 2, "iv": 42.0},
        {"ticker": "NVDA", "strike_price": 120, "option_type": "PUT",
         "expiration": "2026-08-15", "premium_paid": 2.1, "quantity": -1, "iv": 38.0},
    ]
    result = compute_portfolio_greeks(fake_positions, get_underlying_price=lambda t: 138.0)
    import json
    print(json.dumps(result, indent=2))
