"""
simulator_engine.py
====================
Phase 4a — What-If Simulator (multi-scenario Monte Carlo).

Simulates the underlying price forward under Geometric Brownian Motion
(risk-neutral drift by default, configurable) to any target date, jointly
varying Price shock, IV shock, Rate shock, and Dividend-yield shock, then
reprices the option (and the P&L versus the position's entry premium) at
EVERY simulated path to produce a full distribution — not just a point
estimate.

Supports 1,000 / 5,000 / 10,000 / 50,000 path presets (or any custom N).
Multiple scenarios can be run and compared side-by-side in one call.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Optional

import numpy as np

from pricing_engine import black_scholes, _intrinsic, _safe_inputs, OptionType

SimPreset = Literal[1000, 5000, 10000, 50000]


@dataclass
class ScenarioInput:
    label: str
    S0: float
    K: float
    T_days_now: int              # calendar days from today to expiration
    target_days_from_now: int    # simulate forward this many calendar days
    r: float
    sigma: float                 # current/base IV (decimal)
    q: float = 0.0
    option_type: OptionType = "CALL"
    premium_paid: float = 0.0
    contract_multiplier: int = 100
    quantity: int = 1
    n_sims: int = 10000
    # scenario shocks (applied to the SIMULATION inputs, not just a single path)
    iv_shock_pts: float = 0.0     # e.g. +5 means +5 IV points applied to sigma used for repricing
    rate_shock_pts: float = 0.0   # in %, e.g. +0.5 means +0.50%
    dividend_shock_pts: float = 0.0
    drift_override: Optional[float] = None  # annualized real-world drift; None = risk-neutral (r-q)
    seed: int = 42


@dataclass
class SimulationResult:
    label: str
    n_sims: int
    expected_underlying_price: float
    expected_option_price: float
    expected_pl: float
    worst_case_pl: float
    best_case_pl: float
    ci_95: tuple
    ci_99: tuple
    expected_drawdown: float
    probability_of_profit: float
    probability_of_loss: float
    breakeven_probability: float
    expected_return_pct: float
    expected_theta_decay_per_day: float
    expected_vega_change: float
    expected_delta: float
    expected_gamma: float
    price_distribution_summary: dict
    pl_distribution_summary: dict
    histogram_prices: dict = field(default_factory=dict)   # for charting: {bin_edges, counts}
    histogram_pl: dict = field(default_factory=dict)


def _percentile(arr: np.ndarray, p: float) -> float:
    return float(np.percentile(arr, p))


def run_scenario(inp: ScenarioInput) -> SimulationResult:
    S0, K, r, sigma, q = inp.S0, inp.K, inp.r, inp.sigma, inp.q
    S0, K, _, r, sigma, q = _safe_inputs(S0, K, max(inp.target_days_from_now, 1) / 365.0, r, sigma, q)

    t_fwd = max(inp.target_days_from_now, 0) / 365.0
    remaining_T_at_target = max((inp.T_days_now - inp.target_days_from_now), 0) / 365.0

    sim_sigma = min(max(sigma + inp.iv_shock_pts / 100.0, 0.001), 5.0)
    sim_r = r + inp.rate_shock_pts / 100.0
    sim_q = max(q + inp.dividend_shock_pts / 100.0, 0.0)
    drift = inp.drift_override if inp.drift_override is not None else (sim_r - sim_q)

    rng = np.random.default_rng(inp.seed)
    n = inp.n_sims
    half = n // 2
    Z = rng.standard_normal(half)
    Z = np.concatenate([Z, -Z])  # antithetic variates for variance reduction
    if len(Z) < n:
        Z = np.concatenate([Z, rng.standard_normal(n - len(Z))])

    if t_fwd <= 0:
        ST = np.full(n, S0)
    else:
        ST = S0 * np.exp((drift - 0.5 * sim_sigma ** 2) * t_fwd + sim_sigma * math.sqrt(t_fwd) * Z)

    # reprice the option at the target date under (possibly shocked) sigma/r/q
    if remaining_T_at_target <= 1e-6:
        option_prices = np.where(inp.option_type == "CALL", np.maximum(ST - K, 0.0), np.maximum(K - ST, 0.0))
    else:
        option_prices = np.empty(n)
        # vectorized BS across the path array
        sqrtT = math.sqrt(remaining_T_at_target)
        with np.errstate(divide="ignore", invalid="ignore"):
            d1 = (np.log(ST / K) + (sim_r - sim_q + 0.5 * sim_sigma ** 2) * remaining_T_at_target) / (sim_sigma * sqrtT)
            d2 = d1 - sim_sigma * sqrtT
        from scipy.stats import norm
        if inp.option_type == "CALL":
            option_prices = ST * np.exp(-sim_q * remaining_T_at_target) * norm.cdf(d1) - \
                             K * np.exp(-sim_r * remaining_T_at_target) * norm.cdf(d2)
        else:
            option_prices = K * np.exp(-sim_r * remaining_T_at_target) * norm.cdf(-d2) - \
                             ST * np.exp(-sim_q * remaining_T_at_target) * norm.cdf(-d1)
        option_prices = np.maximum(option_prices, 0.0)

    mult, qty = inp.contract_multiplier, inp.quantity
    pl = (option_prices - inp.premium_paid) * mult * qty
    total_cost = inp.premium_paid * mult * abs(qty)

    expected_S = float(np.mean(ST))
    expected_price = float(np.mean(option_prices))
    expected_pl = float(np.mean(pl))
    worst = float(np.min(pl))
    best = float(np.max(pl))
    ci95 = (_percentile(pl, 2.5), _percentile(pl, 97.5))
    ci99 = (_percentile(pl, 0.5), _percentile(pl, 99.5))

    # expected drawdown: mean of the negative tail below zero (shortfall)
    losses = pl[pl < 0]
    expected_drawdown = float(np.mean(losses)) if len(losses) else 0.0

    pop = float(np.mean(pl > 0) * 100)
    pol = float(np.mean(pl <= 0) * 100)
    breakeven_band = total_cost * 0.02 if total_cost else 0.5
    breakeven_prob = float(np.mean(np.abs(pl) < breakeven_band) * 100)

    expected_return_pct = (expected_pl / total_cost * 100) if total_cost > 0 else 0.0

    # Expected Greeks at the target date/price (evaluated at expected underlying)
    if remaining_T_at_target > 1e-6:
        bs = black_scholes(expected_S, K, remaining_T_at_target, sim_r, sim_sigma, sim_q, inp.option_type)
        exp_delta, exp_gamma, exp_theta, exp_vega = bs.delta, bs.gamma, bs.theta, bs.vega
    else:
        exp_delta = 1.0 if (inp.option_type == "CALL" and expected_S > K) else (
            -1.0 if (inp.option_type == "PUT" and expected_S < K) else 0.0)
        exp_gamma = exp_theta = exp_vega = 0.0

    price_hist_counts, price_hist_edges = np.histogram(ST, bins=40)
    pl_hist_counts, pl_hist_edges = np.histogram(pl, bins=40)

    return SimulationResult(
        label=inp.label, n_sims=n,
        expected_underlying_price=round(expected_S, 2),
        expected_option_price=round(expected_price, 4),
        expected_pl=round(expected_pl, 2),
        worst_case_pl=round(worst, 2), best_case_pl=round(best, 2),
        ci_95=(round(ci95[0], 2), round(ci95[1], 2)),
        ci_99=(round(ci99[0], 2), round(ci99[1], 2)),
        expected_drawdown=round(expected_drawdown, 2),
        probability_of_profit=round(pop, 2), probability_of_loss=round(pol, 2),
        breakeven_probability=round(breakeven_prob, 2),
        expected_return_pct=round(expected_return_pct, 2),
        expected_theta_decay_per_day=round(exp_theta, 4),
        expected_vega_change=round(exp_vega, 4),
        expected_delta=round(exp_delta, 4), expected_gamma=round(exp_gamma, 6),
        price_distribution_summary={
            "mean": round(expected_S, 2), "std": round(float(np.std(ST)), 2),
            "p5": round(_percentile(ST, 5), 2), "p25": round(_percentile(ST, 25), 2),
            "median": round(_percentile(ST, 50), 2), "p75": round(_percentile(ST, 75), 2),
            "p95": round(_percentile(ST, 95), 2),
        },
        pl_distribution_summary={
            "mean": round(expected_pl, 2), "std": round(float(np.std(pl)), 2),
            "p5": round(_percentile(pl, 5), 2), "p25": round(_percentile(pl, 25), 2),
            "median": round(_percentile(pl, 50), 2), "p75": round(_percentile(pl, 75), 2),
            "p95": round(_percentile(pl, 95), 2),
        },
        histogram_prices={"counts": price_hist_counts.tolist(), "edges": [round(e, 2) for e in price_hist_edges]},
        histogram_pl={"counts": pl_hist_counts.tolist(), "edges": [round(e, 2) for e in pl_hist_edges]},
    )


def run_multi_scenario(scenarios: list[ScenarioInput]) -> list[SimulationResult]:
    """Run several scenarios (different price/date/IV/rate/dividend assumptions)
    in one call so they can be compared side-by-side in the UI."""
    return [run_scenario(s) for s in scenarios]


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    base = dict(S0=138, K=140, T_days_now=66, r=0.05, sigma=0.42, q=0.0,
                option_type="CALL", premium_paid=5.20, quantity=2)

    scenarios = [
        ScenarioInput(label="Base case (30d fwd, no shock)", target_days_from_now=30, n_sims=10000, **base),
        ScenarioInput(label="IV crush -10pts", target_days_from_now=30, n_sims=10000,
                       iv_shock_pts=-10, **base),
        ScenarioInput(label="Rate +1%, 50000 sims", target_days_from_now=30, n_sims=50000,
                       rate_shock_pts=1.0, **base),
    ]
    results = run_multi_scenario(scenarios)
    for r in results:
        print(f"\n[{r.label}] n={r.n_sims}")
        print(f"  Expected S={r.expected_underlying_price} Expected option={r.expected_option_price} "
              f"Expected P&L={r.expected_pl} ({r.expected_return_pct}%)")
        print(f"  POP={r.probability_of_profit}% POL={r.probability_of_loss}% "
              f"95% CI={r.ci_95} 99% CI={r.ci_99}")
        print(f"  Worst={r.worst_case_pl} Best={r.best_case_pl} ExpDrawdown={r.expected_drawdown}")
        print(f"  Expected Delta={r.expected_delta} Theta/day={r.expected_theta_decay_per_day} "
              f"Vega={r.expected_vega_change}")
