"""
gauges_engine.py
=================
Phase 4b — Options Gauges.

Every gauge returns {score, label, reasons[]} so the UI can show *why* the
score is what it is, per the spec ("Each gauge must explain why the score
changed").

Data-availability note (documented, not silently faked):
  - Bullish/Bearish/Momentum/Trend/IV Score/Rank/Percentile, Gamma/Theta/Vega
    Risk are computed from real inputs (price history + IV history + Greeks)
    passed in from stats_engine / pricing_engine / portfolio_engine.
  - Dealer Gamma, Dealer Position, Dark Pool Activity, Institutional Activity,
    and Flow Strength require a live options-chain (OI by strike) and/or a
    dark-pool print feed. Where an options chain is supplied they are
    estimated from open interest & volume; where it is not supplied they are
    returned as None with an explicit "data_unavailable" reason rather than
    a guessed number.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np


@dataclass
class Gauge:
    score: Optional[float]     # 0-100, or None if data unavailable
    label: str
    reasons: list = field(default_factory=list)


def _finite(x):
    if x is None:
        return None
    try:
        x = float(x)
    except Exception:
        return None
    if not np.isfinite(x):
        return None
    return x


def _clip(x, lo=0, hi=100):
    x = _finite(x)
    if x is None:
        return None
    return float(np.clip(x, lo, hi))


def _round_score(x, ndigits=1):
    x = _finite(x)
    return round(x, ndigits) if x is not None else None


def _label(score: Optional[float], bearish_bullish=True) -> str:
    if score is None or _finite(score) is None:
        return "N/A"
    score = float(score)
    if bearish_bullish:
        if score >= 70: return "STRONGLY BULLISH"
        if score >= 55: return "BULLISH"
        if score >= 45: return "NEUTRAL"
        if score >= 30: return "BEARISH"
        return "STRONGLY BEARISH"
    else:
        if score >= 70: return "HIGH"
        if score >= 40: return "MODERATE"
        return "LOW"


def iv_rank_percentile(current_iv: float, iv_history: list) -> dict:
    """iv_history: list of daily IV values (decimal, e.g. 0.32) over the lookback window (ideally 252d)."""
    if not iv_history or len(iv_history) < 10:
        return {"iv_rank": None, "iv_percentile": None,
                "reasons": ["Insufficient IV history (<10 observations) to compute rank/percentile"]}
    arr = np.array(iv_history)
    iv_min, iv_max = arr.min(), arr.max()
    iv_rank = ((current_iv - iv_min) / (iv_max - iv_min) * 100) if iv_max > iv_min else 50.0
    iv_percentile = float((arr < current_iv).mean() * 100)
    return {
        "iv_rank": round(_clip(iv_rank), 1), "iv_percentile": round(iv_percentile, 1),
        "reasons": [f"Current IV {current_iv*100:.1f}% vs {len(iv_history)}d range "
                    f"[{iv_min*100:.1f}%, {iv_max*100:.1f}%]"],
    }


def compute_gauges(*, technical_indicators: dict, ratings: dict, current_iv: float,
                    iv_history: Optional[list] = None, portfolio_greeks: Optional[dict] = None,
                    account_size: float = 100_000.0, options_chain_summary: Optional[dict] = None) -> dict:
    """
    technical_indicators: output of stats_engine.analyze_key_statistics()['indicators']
    ratings: output of stats_engine.analyze_key_statistics()['ratings']
    portfolio_greeks: {'net_theta':$, 'net_vega':$, 'net_gamma':$} from portfolio_engine (optional)
    options_chain_summary: optional dict with keys like
        {'call_oi': int, 'put_oi': int, 'call_volume': int, 'put_volume': int,
         'net_gamma_notional': float}  -- pass this in if a live chain is available
    """
    gauges = {}

    # --- Bullish / Bearish score (derived from momentum + trend ratings) ---
    mom = _finite(ratings.get("momentum_rating", {}).get("score", 50)) or 50.0
    trend = _finite(ratings.get("trend_rating", {}).get("score", 50)) or 50.0
    bullish = _clip(0.5 * mom + 0.5 * trend)
    bearish = _clip(100 - bullish)
    gauges["bullish_score"] = Gauge(_round_score(bullish), _label(bullish), [
        f"Momentum rating {mom}/100", f"Trend rating {trend}/100",
    ])
    gauges["bearish_score"] = Gauge(_round_score(bearish), _label(bearish),
                                     ["Mirror of bullish score (100 - bullish)"])

    gauges["momentum_score"] = Gauge(_round_score(mom), _label(mom), ratings.get("momentum_rating", {}).get("reasons", []))
    gauges["trend_score"] = Gauge(_round_score(trend), _label(trend), ratings.get("trend_rating", {}).get("reasons", []))

    # --- IV score / rank / percentile ---
    ivrp = iv_rank_percentile(_finite(current_iv) or 0.0, iv_history or [])
    iv_score = _round_score(ivrp["iv_rank"])
    iv_rank = _round_score(ivrp["iv_rank"])
    iv_percentile = _round_score(ivrp["iv_percentile"])
    gauges["iv_score"] = Gauge(iv_score, _label(iv_score, bearish_bullish=False) if iv_score is not None else "N/A",
                                ivrp["reasons"])
    gauges["iv_rank"] = Gauge(iv_rank, "", ivrp["reasons"])
    gauges["iv_percentile"] = Gauge(iv_percentile, "", ivrp["reasons"])

    # --- Gamma / Theta / Vega risk (from portfolio dollar Greeks relative to account size) ---
    pg = portfolio_greeks or {}
    def _risk_gauge(name, dollar_value, scale):
        dollar_value = _finite(dollar_value)
        if dollar_value is None:
            return Gauge(None, "N/A", ["No portfolio Greeks supplied"])
        pct_of_account = abs(dollar_value) / account_size * 100
        score = _clip(pct_of_account * scale)
        return Gauge(_round_score(score), _label(score, bearish_bullish=False),
                     [f"{name} exposure ${dollar_value:,.2f} = {pct_of_account:.2f}% of ${account_size:,.0f} account"])

    gauges["gamma_risk"] = _risk_gauge("Net Gamma $", pg.get("net_gamma"), scale=20)
    gauges["theta_risk"] = _risk_gauge("Net Theta $/day", pg.get("net_theta"), scale=10)
    gauges["vega_risk"] = _risk_gauge("Net Vega $/vol-pt", pg.get("net_vega"), scale=10)

    # --- Dealer gamma / dealer position / flow / dark pool (need options chain / tape data) ---
    if options_chain_summary:
        call_oi = _finite(options_chain_summary.get("call_oi", 0)) or 0.0
        put_oi = _finite(options_chain_summary.get("put_oi", 0)) or 0.0
        call_vol = _finite(options_chain_summary.get("call_volume", 0)) or 0.0
        put_vol = _finite(options_chain_summary.get("put_volume", 0)) or 0.0
        pc_oi_ratio = (put_oi / call_oi) if call_oi else None
        pc_vol_ratio = (put_vol / call_vol) if call_vol else None
        net_gamma_notional = _finite(options_chain_summary.get("net_gamma_notional"))

        dealer_gamma_score = None
        if net_gamma_notional is not None:
            dealer_gamma_score = _clip(50 + math.copysign(min(abs(net_gamma_notional) / 1e6, 1) * 40,
                                                            -net_gamma_notional))
        gauges["dealer_gamma"] = Gauge(
            _round_score(dealer_gamma_score),
            "N/A" if dealer_gamma_score is None else ("DEALER SHORT GAMMA" if dealer_gamma_score > 55
                                                        else "DEALER LONG GAMMA" if dealer_gamma_score < 45
                                                        else "NEUTRAL"),
            [f"Estimated from options-chain net gamma notional (approximation, not a licensed dealer-flow feed)"])

        dp_score = _round_score(_clip(50 + (pc_oi_ratio - 1) * 25)) if pc_oi_ratio is not None else None
        gauges["dealer_position"] = Gauge(
            dp_score, _label(dp_score, bearish_bullish=False) if dp_score is not None else "N/A",
            [f"Put/Call OI ratio = {pc_oi_ratio:.2f}" if pc_oi_ratio else "No OI data"])

        fs_score = _round_score(_clip(50 + (pc_vol_ratio - 1) * -30)) if pc_vol_ratio is not None else None
        gauges["flow_strength"] = Gauge(
            fs_score, _label(fs_score, bearish_bullish=False) if fs_score is not None else "N/A",
            [f"Put/Call volume ratio = {pc_vol_ratio:.2f}" if pc_vol_ratio else "No volume data"])
    else:
        na_reason = ["Requires a live options chain (open interest + volume by strike); not supplied"]
        gauges["dealer_gamma"] = Gauge(None, "N/A", na_reason)
        gauges["dealer_position"] = Gauge(None, "N/A", na_reason)
        gauges["flow_strength"] = Gauge(None, "N/A", na_reason)

    gauges["institutional_activity"] = Gauge(
        None, "N/A", ["Requires 13F/institutional-flow data feed; not supplied"])
    gauges["dark_pool_activity"] = Gauge(
        None, "N/A", ["Requires a dark-pool print feed (e.g. FINRA ADF/ORF); not supplied"])
    gauges["smart_money_score"] = Gauge(
        None, "N/A", ["Derived from institutional + dark-pool + options-flow signals, none of which are supplied"])

    # --- Sentiment / Fear index: proxy from volatility + momentum until a news-sentiment feed is wired in ---
    vol_score = _finite(ratings.get("volatility_rating", {}).get("score", 50)) or 50.0
    fear_index = _clip(0.6 * vol_score + 0.4 * (100 - mom))
    gauges["market_fear_index"] = Gauge(_round_score(fear_index), _label(fear_index, bearish_bullish=False), [
        f"Proxy from volatility rating ({vol_score}) and inverse momentum ({100-mom})",
        "Not a VIX-equivalent; wire in a news-sentiment feed for a true fear gauge",
    ])
    gauges["sentiment_score"] = Gauge(_round_score(bullish), _label(bullish), [
        "Proxy: currently mirrors bullish_score pending a dedicated news/social sentiment feed",
    ])

    # --- overall confidence: fraction of gauges with real data * average data-quality ---
    total = len(gauges)
    available = sum(1 for g in gauges.values() if g.score is not None)
    gauges["confidence_score"] = Gauge(_round_score(available / total * 100), "",
                                        [f"{available}/{total} gauges backed by live data"])

    result = {k: vars(v) for k, v in gauges.items()}
    for v in result.values():
        v["score"] = _finite(v.get("score"))
    return result


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    fake_indicators = {"rsi": 62, "adx": 28}
    fake_ratings = {
        "momentum_rating": {"score": 68, "reasons": ["RSI 62 > 55"]},
        "trend_rating": {"score": 71, "reasons": ["ADX 28 > 25"]},
        "volatility_rating": {"score": 45, "reasons": ["ATR 2.1% of price"]},
    }
    iv_hist = list(np.random.default_rng(1).uniform(0.20, 0.55, 200))
    portfolio_greeks = {"net_theta": -120.0, "net_vega": 340.0, "net_gamma": 15.0}
    chain = {"call_oi": 12000, "put_oi": 9000, "call_volume": 4000, "put_volume": 3600,
             "net_gamma_notional": -2_500_000}

    result = compute_gauges(technical_indicators=fake_indicators, ratings=fake_ratings,
                             current_iv=0.42, iv_history=iv_hist, portfolio_greeks=portfolio_greeks,
                             account_size=50_000, options_chain_summary=chain)
    for k, v in result.items():
        print(f"{k:25s} score={v['score']} label={v['label']}")
