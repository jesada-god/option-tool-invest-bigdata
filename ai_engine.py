"""
ai_engine.py
============
Phase 4c — AI Prediction Engine.

This is NOT a trained ML model (no labeled training set was provided/exists
in this codebase) — it is a transparent, weighted-factor combiner, which is
the honest and auditable approach for a trading tool: every input factor is
a real, computed number (technical, Greeks, IV, volume) or explicitly None
when the data source isn't wired in (options flow, news sentiment, macro).
Weights are renormalized across whatever factors ARE available, exactly
like `pricing_engine.price_consensus`'s model-dropout logic, so a missing
factor never silently becomes "0" or "50" and skews the result.

Output: Bullish / Bearish / Neutral probabilities (sum to 100) + a
confidence score + a ranked, weighted list of WHY.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np


# Each factor's score is 0-100 where 100 = maximally bullish, 0 = maximally
# bearish, 50 = neutral. `None` means "no data available for this factor".
FACTOR_WEIGHTS = {
    "technical": 0.20,       # RSI/MACD/ADX/EMA structure  (stats_engine ratings)
    "fundamental": 0.10,     # analyst consensus / EPS trend / PEG
    "greeks": 0.10,          # portfolio delta/gamma positioning skew
    "iv": 0.10,              # IV rank/percentile (mean-reversion signal)
    "volume": 0.10,          # relative volume / OBV trend
    "options_flow": 0.10,    # put/call ratio, dealer gamma
    "market_trend": 0.10,    # broad market (SPY) trend
    "sector_trend": 0.05,    # sector ETF trend
    "macro": 0.05,           # rates/inflation backdrop
    "news_sentiment": 0.05,  # news/social sentiment feed
    "risk": 0.025,           # inverse of volatility/tail risk
    "correlation": 0.025,    # correlation-adjusted diversification signal
}


@dataclass
class FactorInput:
    technical: Optional[float] = None
    fundamental: Optional[float] = None
    greeks: Optional[float] = None
    iv: Optional[float] = None
    volume: Optional[float] = None
    options_flow: Optional[float] = None
    market_trend: Optional[float] = None
    sector_trend: Optional[float] = None
    macro: Optional[float] = None
    news_sentiment: Optional[float] = None
    risk: Optional[float] = None
    correlation: Optional[float] = None
    notes: dict = field(default_factory=dict)   # optional per-factor human-readable reason


@dataclass
class AIPrediction:
    bullish_probability: float
    bearish_probability: float
    neutral_probability: float
    confidence_score: float
    weighted_reasoning: list
    factors_used: int
    factors_total: int


def predict(factors: FactorInput) -> AIPrediction:
    values = vars(factors)
    notes = values.pop("notes", {})
    available = {k: v for k, v in values.items() if v is not None}

    total_weight = sum(FACTOR_WEIGHTS[k] for k in available)
    if total_weight == 0:
        return AIPrediction(33.3, 33.3, 33.4, 0.0,
                             [{"factor": "none", "detail": "No factors available", "weight_pct": 0}], 0, len(values))

    weighted_score = sum(v * (FACTOR_WEIGHTS[k] / total_weight) for k, v in available.items())

    # Convert 0-100 bullishness score into a 3-way probability split.
    # Distance from 50 drives conviction; a very neutral aggregate score
    # produces a high neutral probability rather than a forced bull/bear call.
    conviction = abs(weighted_score - 50) / 50  # 0..1
    neutral_prob = max(10.0, 40.0 * (1 - conviction))
    directional_pool = 100 - neutral_prob
    if weighted_score >= 50:
        bullish_prob = directional_pool * (0.5 + conviction / 2)
        bearish_prob = directional_pool - bullish_prob
    else:
        bearish_prob = directional_pool * (0.5 + conviction / 2)
        bullish_prob = directional_pool - bearish_prob

    reasoning = []
    for k, v in sorted(available.items(), key=lambda kv: -FACTOR_WEIGHTS[kv[0]]):
        contribution_pct = round(FACTOR_WEIGHTS[k] / total_weight * 100, 1)
        direction = "bullish" if v > 55 else "bearish" if v < 45 else "neutral"
        reasoning.append({
            "factor": k, "score": round(v, 1), "direction": direction,
            "weight_pct": contribution_pct,
            "detail": notes.get(k, f"{k.replace('_',' ').title()} factor scored {v:.1f}/100 ({direction})"),
        })

    data_completeness = len(available) / len(values)
    # confidence blends how much data we had with how decisive/consistent it was
    dispersion = float(np.std(list(available.values()))) if len(available) > 1 else 0.0
    agreement = max(0.0, 1 - dispersion / 50)
    confidence = round(100 * (0.5 * data_completeness + 0.5 * agreement), 1)

    return AIPrediction(
        bullish_probability=round(bullish_prob, 1),
        bearish_probability=round(bearish_prob, 1),
        neutral_probability=round(neutral_prob, 1),
        confidence_score=confidence,
        weighted_reasoning=reasoning,
        factors_used=len(available), factors_total=len(values),
    )


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    factors = FactorInput(
        technical=68, fundamental=55, greeks=60, iv=40, volume=58,
        options_flow=52, market_trend=62, risk=45,
        notes={"iv": "IV rank 40th percentile — not particularly cheap or expensive"},
        # sector_trend, macro, news_sentiment, correlation intentionally omitted (no feed wired in)
    )
    result = predict(factors)
    print(f"Bullish={result.bullish_probability}% Bearish={result.bearish_probability}% "
          f"Neutral={result.neutral_probability}%  Confidence={result.confidence_score}%")
    print(f"Factors used: {result.factors_used}/{result.factors_total}")
    for r in result.weighted_reasoning:
        print(f"  [{r['weight_pct']}%] {r['factor']:15s} {r['score']:5.1f} ({r['direction']}) — {r['detail']}")
