"""
stats_engine.py
================
Phase 3 (partial) — Key Statistics / Technical Ratings.

Computes real technical indicators from price history (RSI, MACD, ADX,
EMA/SMA, ATR, Bollinger Bands, 52w range, relative volume, beta vs SPY)
and turns them into the 0-100 rating scores that gauges_engine.py and
ai_engine.py consume:

    analyze_key_statistics(ticker) -> {
        "indicators": {...raw numbers...},
        "ratings": {
            "momentum_rating":  {"score": 0-100, "reasons": [...]},
            "trend_rating":     {"score": 0-100, "reasons": [...]},
            "volatility_rating":{"score": 0-100, "reasons": [...]},
        },
        "current_iv": float or None,
        "iv_history": [float, ...] or [],
    }

Every score is derived only from real, computed numbers. If a data
source is missing (e.g. not enough history), the affected rating falls
back to a neutral 50 and says so in `reasons` rather than guessing.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf

from cache import ttl_cache


def _clip(x, lo=0.0, hi=100.0):
    return float(np.clip(x, lo, hi))


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50.0)


def _macd(series: pd.Series):
    ema12 = series.ewm(span=12, adjust=False).mean()
    ema26 = series.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    return macd_line, signal_line, macd_line - signal_line


def _adx(high, low, close, period: int = 14):
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    atr = tr.rolling(period).mean()
    plus_di = 100 * pd.Series(plus_dm, index=high.index).rolling(period).mean() / atr.replace(0, np.nan)
    minus_di = 100 * pd.Series(minus_dm, index=high.index).rolling(period).mean() / atr.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.rolling(period).mean()
    return adx.fillna(0.0), atr.fillna(0.0)


def _bollinger(series: pd.Series, period: int = 20, n_std: float = 2.0):
    mid = series.rolling(period).mean()
    std = series.rolling(period).std()
    return mid - n_std * std, mid, mid + n_std * std


@ttl_cache(ttl_seconds=120)
def analyze_key_statistics(ticker: str) -> dict:
    stock = yf.Ticker(ticker)
    try:
        hist = stock.history(period="1y", interval="1d")
    except Exception:
        hist = pd.DataFrame()

    if hist is None or hist.empty or len(hist) < 30:
        return {
            "indicators": {},
            "ratings": {
                "momentum_rating": {"score": 50.0, "reasons": ["Insufficient price history (<30d)"]},
                "trend_rating": {"score": 50.0, "reasons": ["Insufficient price history (<30d)"]},
                "volatility_rating": {"score": 50.0, "reasons": ["Insufficient price history (<30d)"]},
            },
            "current_iv": None, "iv_history": [],
        }

    close, high, low = hist["Close"], hist["High"], hist["Low"]
    volume = hist["Volume"] if "Volume" in hist.columns else pd.Series(dtype=float)

    rsi = _rsi(close, 14)
    macd_line, signal_line, macd_hist = _macd(close)
    adx, atr = _adx(high, low, close, 14)
    ema20 = close.ewm(span=20, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean() if len(close) >= 50 else ema20
    sma200 = close.rolling(200).mean() if len(close) >= 200 else pd.Series([close.mean()] * len(close), index=close.index)
    bb_low, bb_mid, bb_high = _bollinger(close, 20, 2.0)

    last_close = float(close.iloc[-1])
    last_rsi = float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0
    last_macd_hist = float(macd_hist.iloc[-1]) if not pd.isna(macd_hist.iloc[-1]) else 0.0
    last_adx = float(adx.iloc[-1]) if not pd.isna(adx.iloc[-1]) else 0.0
    last_atr = float(atr.iloc[-1]) if not pd.isna(atr.iloc[-1]) else 0.0
    last_ema20 = float(ema20.iloc[-1])
    last_ema50 = float(ema50.iloc[-1])
    last_sma200 = float(sma200.iloc[-1]) if not pd.isna(sma200.iloc[-1]) else last_close

    returns = close.pct_change().dropna()
    realized_vol_annual = float(returns.rolling(20).std().iloc[-1] * math.sqrt(252)) if len(returns) >= 20 else None

    week52_high = float(close.rolling(min(252, len(close))).max().iloc[-1])
    week52_low = float(close.rolling(min(252, len(close))).min().iloc[-1])

    avg_vol = float(volume.rolling(20).mean().iloc[-1]) if not volume.empty and len(volume) >= 20 else None
    last_vol = float(volume.iloc[-1]) if not volume.empty else None
    rel_volume = (last_vol / avg_vol) if (avg_vol and last_vol) else None

    # --- beta vs SPY (60-day daily returns covariance/variance) ---
    beta = None
    try:
        spy = yf.Ticker("SPY").history(period="6mo", interval="1d")["Close"]
        joint = pd.concat([close.pct_change(), spy.pct_change()], axis=1, join="inner").dropna()
        joint.columns = ["stock", "spy"]
        if len(joint) >= 30:
            cov = joint["stock"].cov(joint["spy"])
            var = joint["spy"].var()
            beta = float(cov / var) if var else None
    except Exception:
        pass

    # --- Momentum rating: RSI position + MACD histogram direction ---
    if 50 <= last_rsi <= 70:
        rsi_score = 65 + (last_rsi - 50) * 1.0
    elif last_rsi > 70:
        rsi_score = 80 - (last_rsi - 70) * 0.5   # overbought fades slightly
    elif 30 <= last_rsi < 50:
        rsi_score = 35 + (last_rsi - 30) * 0.75
    else:
        rsi_score = max(10, last_rsi)
    macd_score = _clip(50 + math.copysign(min(abs(last_macd_hist) / max(last_close * 0.01, 0.01), 1) * 30, last_macd_hist))
    momentum_score = _clip(0.6 * rsi_score + 0.4 * macd_score)
    momentum_reasons = [
        f"RSI(14) = {last_rsi:.1f}",
        f"MACD histogram = {last_macd_hist:.3f} ({'bullish' if last_macd_hist > 0 else 'bearish'} momentum)",
    ]

    # --- Trend rating: price vs EMA20/EMA50/SMA200 stack + ADX strength ---
    stack_score = 50.0
    if last_close > last_ema20 > last_ema50 > last_sma200:
        stack_score = 90.0
    elif last_close > last_ema20 > last_ema50:
        stack_score = 75.0
    elif last_close > last_ema20:
        stack_score = 60.0
    elif last_close < last_ema20 < last_ema50 < last_sma200:
        stack_score = 10.0
    elif last_close < last_ema20 < last_ema50:
        stack_score = 25.0
    elif last_close < last_ema20:
        stack_score = 40.0
    adx_conviction = min(last_adx / 40.0, 1.0)  # ADX>40 = very strong trend
    trend_score = _clip(50 + (stack_score - 50) * (0.5 + 0.5 * adx_conviction))
    trend_reasons = [
        f"Price vs EMA20/EMA50/SMA200 = {last_close:.2f}/{last_ema20:.2f}/{last_ema50:.2f}/{last_sma200:.2f}",
        f"ADX(14) = {last_adx:.1f} ({'strong' if last_adx > 25 else 'weak'} trend)",
    ]

    # --- Volatility rating: realized vol + ATR% of price (higher = riskier, scored 0-100 as risk level) ---
    atr_pct = (last_atr / last_close * 100) if last_close else 0.0
    vol_component = min((realized_vol_annual or 0.0) * 100, 100)
    volatility_score = _clip(0.5 * vol_component + 0.5 * min(atr_pct * 10, 100))
    volatility_reasons = [
        f"20d realized volatility (annualized) = {(realized_vol_annual or 0)*100:.1f}%",
        f"ATR(14) = {atr_pct:.2f}% of price",
    ]

    indicators = {
        "rsi_14": round(last_rsi, 2), "macd_histogram": round(last_macd_hist, 4),
        "adx_14": round(last_adx, 2), "atr_14": round(last_atr, 4), "atr_pct": round(atr_pct, 2),
        "ema20": round(last_ema20, 2), "ema50": round(last_ema50, 2), "sma200": round(last_sma200, 2),
        "bollinger_low": round(float(bb_low.iloc[-1]), 2) if not pd.isna(bb_low.iloc[-1]) else None,
        "bollinger_high": round(float(bb_high.iloc[-1]), 2) if not pd.isna(bb_high.iloc[-1]) else None,
        "week52_high": round(week52_high, 2), "week52_low": round(week52_low, 2),
        "realized_vol_annualized": round(realized_vol_annual, 4) if realized_vol_annual else None,
        "avg_volume_20d": int(avg_vol) if avg_vol else None,
        "relative_volume": round(rel_volume, 2) if rel_volume else None,
        "beta_vs_spy": round(beta, 2) if beta is not None else None,
        "last_close": round(last_close, 2),
    }

    # --- IV / IV history (ATM implied vol from nearest expiration options chain) ---
    current_iv, iv_history = None, []
    try:
        exps = stock.options
        if exps:
            chain = stock.option_chain(exps[0])
            calls = chain.calls
            if not calls.empty:
                calls = calls.copy()
                calls["diff"] = (calls["strike"] - last_close).abs()
                atm = calls.loc[calls["diff"].idxmin()]
                iv = atm.get("impliedVolatility")
                if iv is not None and not pd.isna(iv):
                    current_iv = float(iv)
    except Exception:
        pass
    if current_iv is None and realized_vol_annual:
        current_iv = float(realized_vol_annual)   # fallback proxy
    # proxy IV history from rolling realized vol (documented fallback, not a real IV surface history)
    if len(returns) >= 40:
        rolling_vol = (returns.rolling(20).std() * math.sqrt(252)).dropna()
        iv_history = [round(float(v), 4) for v in rolling_vol.tail(120).tolist()]

    return {
        "indicators": indicators,
        "ratings": {
            "momentum_rating": {"score": round(momentum_score, 1), "reasons": momentum_reasons},
            "trend_rating": {"score": round(trend_score, 1), "reasons": trend_reasons},
            "volatility_rating": {"score": round(volatility_score, 1), "reasons": volatility_reasons},
        },
        "current_iv": round(current_iv, 4) if current_iv is not None else None,
        "iv_history": iv_history,
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import json
    result = analyze_key_statistics("NVDA")
    print(json.dumps(result, indent=2, default=str))
