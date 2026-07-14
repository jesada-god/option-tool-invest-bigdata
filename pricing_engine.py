"""
pricing_engine.py
==================
Phase 1 — Core Pricing Engine.

Provides:
  - black_scholes(): closed-form European price + full analytic Greeks
    (delta, gamma, theta, vega, rho), numerically hardened against
    T<=0, sigma<=0, S/K<=0, divide-by-zero and NaN propagation.
  - binomial_tree(): Cox-Ross-Rubinstein binomial lattice, supports
    European AND American exercise (early-exercise optimal stopping).
  - price_consensus(): runs every applicable model (Black-Scholes,
    Binomial for American, Binomial for European cross-check), assigns
    confidence weights, and returns a weighted consensus price plus the
    per-model breakdown so callers can see how much models agree.
  - _safe_inputs() / _intrinsic(): shared validation + intrinsic-value
    helpers used by the simulator/gauges/AI engines.

This is intentionally dependency-light (numpy only) so it can be
imported by simulator_engine.py, gauges_engine.py, and portfolio_engine.py
without pulling in the whole app.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np
from scipy.stats import norm

OptionType = Literal["CALL", "PUT"]

# ---------------------------------------------------------------------------
# Input validation / numerical hardening
# ---------------------------------------------------------------------------
def _safe_inputs(S: float, K: float, T: float, r: float, sigma: float, q: float = 0.0):
    """Clamp every pricing input into a numerically sane range so downstream
    math can never divide by zero, take log(<=0), or produce NaN/Inf."""
    S = float(S) if S is not None and not math.isnan(S) else 0.01
    K = float(K) if K is not None and not math.isnan(K) else 0.01
    S = max(S, 0.0001)
    K = max(K, 0.0001)
    T = float(T) if T is not None and not math.isnan(T) else 0.0
    T = max(T, 0.0)
    r = float(r) if r is not None and not math.isnan(r) else 0.0
    r = max(min(r, 1.0), -0.5)              # sane rate bounds (-50%..100%)
    sigma = float(sigma) if sigma is not None and not math.isnan(sigma) else 0.30
    sigma = min(max(sigma, 0.001), 5.0)     # 0.1% .. 500% IV
    q = float(q) if q is not None and not math.isnan(q) else 0.0
    q = min(max(q, 0.0), 1.0)
    return S, K, T, r, sigma, q


def _intrinsic(S: float, K: float, option_type: OptionType) -> float:
    return max(S - K, 0.0) if option_type == "CALL" else max(K - S, 0.0)


# ---------------------------------------------------------------------------
# Black-Scholes-Merton (European, continuous dividend yield q)
# ---------------------------------------------------------------------------
@dataclass
class BSResult:
    price: float
    delta: float
    gamma: float
    theta: float     # per calendar day
    vega: float       # per 1 vol point (1.00 = 100%, i.e. divide by 100 already applied)
    rho: float         # per 1% rate move
    intrinsic: float
    extrinsic: float
    d1: float
    d2: float
    model: str = "black_scholes"


def black_scholes(S: float, K: float, T: float, r: float, sigma: float,
                   q: float = 0.0, option_type: OptionType = "CALL") -> BSResult:
    S, K, T, r, sigma, q = _safe_inputs(S, K, T, r, sigma, q)
    intrinsic = _intrinsic(S, K, option_type)

    if T <= 1e-8:
        # At/after expiration: price collapses to intrinsic, Greeks degenerate cleanly.
        if option_type == "CALL":
            delta = 1.0 if S > K else (0.5 if S == K else 0.0)
        else:
            delta = -1.0 if S < K else (-0.5 if S == K else 0.0)
        return BSResult(price=round(float(intrinsic), 6), delta=delta, gamma=0.0, theta=0.0,
                         vega=0.0, rho=0.0, intrinsic=round(float(intrinsic), 6), extrinsic=0.0,
                         d1=0.0, d2=0.0)

    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma ** 2) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT

    Nd1, Nd2 = norm.cdf(d1), norm.cdf(d2)
    nNd1 = norm.pdf(d1)
    disc_r = math.exp(-r * T)
    disc_q = math.exp(-q * T)

    if option_type == "CALL":
        price = S * disc_q * Nd1 - K * disc_r * Nd2
        delta = disc_q * Nd1
        theta_annual = (-(S * disc_q * nNd1 * sigma) / (2 * sqrtT)
                         - r * K * disc_r * Nd2 + q * S * disc_q * Nd1)
        rho = K * T * disc_r * Nd2 / 100.0
    else:
        price = K * disc_r * norm.cdf(-d2) - S * disc_q * norm.cdf(-d1)
        delta = -disc_q * norm.cdf(-d1)
        theta_annual = (-(S * disc_q * nNd1 * sigma) / (2 * sqrtT)
                         + r * K * disc_r * norm.cdf(-d2) - q * S * disc_q * norm.cdf(-d1))
        rho = -K * T * disc_r * norm.cdf(-d2) / 100.0

    price = max(price, 0.0)
    gamma = (disc_q * nNd1) / (S * sigma * sqrtT)
    vega = (S * disc_q * nNd1 * sqrtT) / 100.0     # per 1 vol POINT (0.01 -> use /100 convention)
    theta_per_day = theta_annual / 365.0
    extrinsic = max(price - intrinsic, 0.0)

    return BSResult(
        price=round(float(price), 6), delta=round(float(delta), 6), gamma=round(float(gamma), 8),
        theta=round(float(theta_per_day), 6), vega=round(float(vega), 6), rho=round(float(rho), 6),
        intrinsic=round(float(intrinsic), 6), extrinsic=round(float(extrinsic), 6),
        d1=round(float(d1), 6), d2=round(float(d2), 6),
    )


# ---------------------------------------------------------------------------
# Binomial tree (Cox-Ross-Rubinstein) — supports American early exercise
# ---------------------------------------------------------------------------
def binomial_tree(S: float, K: float, T: float, r: float, sigma: float, q: float = 0.0,
                   option_type: OptionType = "CALL", steps: int = 200,
                   american: bool = True) -> dict:
    S, K, T, r, sigma, q = _safe_inputs(S, K, T, r, sigma, q)
    if T <= 1e-8:
        return {"price": round(float(_intrinsic(S, K, option_type)), 6), "model": "binomial_tree",
                "steps": steps, "american": american}

    steps = max(int(steps), 2)
    dt = T / steps
    u = math.exp(sigma * math.sqrt(dt))
    d = 1.0 / u
    disc = math.exp(-r * dt)
    p = (math.exp((r - q) * dt) - d) / (u - d)
    p = min(max(p, 1e-9), 1 - 1e-9)  # numerical stability guard (no-arbitrage should keep 0<p<1)

    # terminal underlying prices at each of the (steps+1) nodes
    j = np.arange(steps + 1)
    ST = S * (u ** (steps - j)) * (d ** j)
    values = np.maximum(ST - K, 0.0) if option_type == "CALL" else np.maximum(K - ST, 0.0)

    for i in range(steps - 1, -1, -1):
        values = disc * (p * values[:-1] + (1 - p) * values[1:])
        if american:
            j = np.arange(i + 1)
            S_i = S * (u ** (i - j)) * (d ** j)
            exercise = np.maximum(S_i - K, 0.0) if option_type == "CALL" else np.maximum(K - S_i, 0.0)
            values = np.maximum(values, exercise)

    price = float(values[0])
    return {"price": round(float(max(price, 0.0)), 6), "model": "binomial_tree",
            "steps": steps, "american": american}


# ---------------------------------------------------------------------------
# Weighted multi-model consensus
# ---------------------------------------------------------------------------
def price_consensus(S: float, K: float, T: float, r: float, sigma: float, q: float = 0.0,
                     option_type: OptionType = "CALL", american: bool = False,
                     binomial_steps: int = 200) -> dict:
    """Runs Black-Scholes (always) + Binomial tree (European cross-check, and
    American if requested), assigns confidence weights, and returns a
    weighted consensus price. If any model produces a NaN/negative/absurd
    price it is dropped and the remaining models are renormalized (graceful
    degradation instead of crashing)."""
    bs = black_scholes(S, K, T, r, sigma, q, option_type)
    binom_euro = binomial_tree(S, K, T, r, sigma, q, option_type, steps=binomial_steps, american=False)

    candidates = [("black_scholes", bs.price, 0.55), ("binomial_european", binom_euro["price"], 0.25)]

    if american:
        binom_amer = binomial_tree(S, K, T, r, sigma, q, option_type, steps=binomial_steps, american=True)
        candidates.append(("binomial_american", binom_amer["price"], 0.20))
    else:
        # Re-normalize the two remaining weights to sum to 1.0
        candidates = [("black_scholes", bs.price, 0.7), ("binomial_european", binom_euro["price"], 0.3)]

    valid = [(name, p, w) for name, p, w in candidates
             if p is not None and not math.isnan(p) and p >= 0 and p < S * 5 + K * 5]
    if not valid:
        valid = [("black_scholes", max(bs.price, 0.0), 1.0)]

    total_w = sum(w for _, _, w in valid)
    consensus = sum(p * (w / total_w) for _, p, w in valid)

    prices = [p for _, p, _ in valid]
    agreement_spread = (max(prices) - min(prices)) if len(prices) > 1 else 0.0
    agreement_pct = 100.0 if consensus == 0 else max(0.0, 100.0 - (agreement_spread / max(consensus, 0.01)) * 100.0)

    return {
        "consensus_price": round(float(consensus), 4),
        "models": [{"model": name, "price": round(float(p), 4), "weight_pct": round(float(w / total_w * 100), 1)}
                   for name, p, w in valid],
        "model_agreement_pct": round(float(agreement_pct), 1),
        "greeks": {"delta": bs.delta, "gamma": bs.gamma, "theta": bs.theta, "vega": bs.vega, "rho": bs.rho},
        "intrinsic": bs.intrinsic, "extrinsic": round(float(consensus - bs.intrinsic), 4),
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    r = black_scholes(100, 100, 30 / 365, 0.05, 0.30, 0.0, "CALL")
    print("BS ATM call:", r)
    print("Binomial American put:", binomial_tree(100, 105, 45 / 365, 0.05, 0.35, 0.0, "PUT", american=True))
    print("Consensus:", price_consensus(100, 100, 30 / 365, 0.05, 0.30, 0.0, "CALL", american=True))
