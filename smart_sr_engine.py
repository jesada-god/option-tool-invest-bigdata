# ---------------------------------------------------------------------------
# 🎯 Smart Support / Resistance Engine (Multi-Factor, v2)
# ---------------------------------------------------------------------------
# แทนที่ระบบ Pivot Point เดิม (High/Low/Close ของแท่งเดียว) ทั้งหมด
# ด้วยระบบ "โซน" แนวรับ-แนวต้านที่วิเคราะห์จากหลายปัจจัยร่วมกัน:
#
#   A. Wick Footprint      -> จุดที่มีไส้เทียนโดน Reject ซ้ำหลายครั้ง (Wick Cluster)
#   B. Base Accumulation   -> ฐานสะสม Sideway Compression ก่อน Breakout -> Demand/Supply Zone
#   C. Psychological Levels-> เลขกลม (100/500/1000/10000 และ 00/25/50/75) ปรับค่าได้
#   D. Orderbook Approx.   -> ไม่มี Order Book จริง จึงประมาณสภาพคล่องจาก Volume Profile
#                              (Volume + Wick + Price Action)
#   F. EMA Confluence      -> เส้น EMA20/50/100/200 ที่ราคาแตะ/สะท้อนซ้ำ = แนวรับ-ต้านแบบ
#                              Dynamic ที่นักลงทุนสถาบัน/สาย Trend-following จับตาอยู่จริง
#                              (สายยาว เช่น EMA100/200 มีน้ำหนักมากกว่าสายสั้น)
#   E. Composite Scoring   -> v2: ใช้โมเดล "ปัจจัยเด่นสุด + โบนัสจากปัจจัยที่ยืนยันซ้ำ"
#                              แทนการถ่วงน้ำหนักเฉลี่ยแบบเดิม เพราะแบบเดิมทำให้สัญญาณเดี่ยว
#                              ที่แข็งแรงจริง (เช่น EMA200 หรือโดน Reject ซ้ำ 5-6 ครั้ง) ถูกฉุด
#                              คะแนนลงจนกลายเป็น "Weak" เกือบทุกเส้น ทั้งที่ไม่ควรเป็นแบบนั้น
#                              พร้อม Label ความมั่นใจ (High / Medium / Weak)
# ---------------------------------------------------------------------------
import math
from typing import Optional

import numpy as np
import pandas as pd

DEFAULT_MAJOR_STEPS = [10000, 5000, 1000, 500, 100, 50, 25, 10, 5, 1]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _dynamic_tolerance(price: float, atr: Optional[float]) -> float:
    """ระยะ tolerance สำหรับจัดกลุ่มราคาที่ใกล้กันให้เป็นโซนเดียวกัน
    อิงจาก ATR ของ timeframe นั้นๆ ถ้าไม่มีให้ใช้ % ของราคาแทน"""
    if atr and atr > 0:
        return max(atr * 0.35, price * 0.001)
    return max(price * 0.0025, 0.01)


def _cluster_prices(points, tolerance):
    """1D greedy clustering: รวมราคาที่ห่างกันไม่เกิน tolerance ให้เป็นกลุ่มเดียว
    points: list ของ (price, weight, bar_index)"""
    if not points:
        return []
    pts = sorted(points, key=lambda x: x[0])
    clusters, current = [], [pts[0]]
    for p in pts[1:]:
        if p[0] - current[-1][0] <= tolerance:
            current.append(p)
        else:
            clusters.append(current)
            current = [p]
    clusters.append(current)

    out = []
    for c in clusters:
        total_w = sum(w for _, w, _ in c)
        price = (sum(p * w for p, w, _ in c) / total_w) if total_w else (sum(p for p, _, _ in c) / len(c))
        out.append({
            "price": price,
            "count": len(c),
            "weight": total_w,
            "last_idx": max(i for _, _, i in c),
        })
    return out


# ---------------------------------------------------------------------------
# A. Wick Footprint — จุดที่ไส้เทียนโดน Reject ซ้ำหลายครั้ง
# ---------------------------------------------------------------------------
def detect_wick_footprint(df: pd.DataFrame, tolerance: float):
    highs, lows, opens, closes = df["High"], df["Low"], df["Open"], df["Close"]
    n = len(df)
    upper_points, lower_points = [], []

    for i in range(n):
        o, c, h, l = float(opens.iloc[i]), float(closes.iloc[i]), float(highs.iloc[i]), float(lows.iloc[i])
        rng = h - l
        if rng <= 0:
            continue
        body_top, body_bot = max(o, c), min(o, c)
        upper_wick = h - body_top
        lower_wick = body_bot - l

        # ไส้เทียนถือว่ามีนัยสำคัญ (โดน Reject แรง) ถ้ายาว >= 45% ของ range ทั้งแท่ง
        recency_w = 1.0 + (i / max(n - 1, 1))  # แท่งล่าสุดมีน้ำหนักมากกว่าแท่งเก่า
        if upper_wick / rng >= 0.45:
            upper_points.append((h, recency_w, i))
        if lower_wick / rng >= 0.45:
            lower_points.append((l, recency_w, i))

    support_clusters = _cluster_prices(lower_points, tolerance)
    resistance_clusters = _cluster_prices(upper_points, tolerance)
    return support_clusters, resistance_clusters


# ---------------------------------------------------------------------------
# B. Base Accumulation — Sideway Compression ก่อน Breakout -> Demand/Supply Zone
# ---------------------------------------------------------------------------
def detect_base_accumulation(df: pd.DataFrame, atr: Optional[float]):
    zones = []
    n = len(df)
    if n < 10 or not atr or atr <= 0:
        return zones

    highs, lows, closes = df["High"].values, df["Low"].values, df["Close"].values
    window = 6
    is_tight = [False] * n
    for i in range(window, n):
        seg_high = highs[i - window:i].max()
        seg_low = lows[i - window:i].min()
        seg_range = seg_high - seg_low
        if seg_range > 0 and seg_range <= atr * 1.4:
            is_tight[i] = True

    i = 0
    while i < n:
        if is_tight[i]:
            j = i
            while j < n and is_tight[j]:
                j += 1
            seg_start = max(i - window, 0)
            seg_end = j - 1
            if (seg_end - seg_start) >= 4:
                zone_low = float(lows[seg_start:seg_end + 1].min())
                zone_high = float(highs[seg_start:seg_end + 1].max())

                breakout_dir, breakout_idx = None, None
                for k in range(seg_end + 1, min(seg_end + 4, n)):
                    if closes[k] > zone_high + atr * 0.3:
                        breakout_dir, breakout_idx = "up", k
                        break
                    if closes[k] < zone_low - atr * 0.3:
                        breakout_dir, breakout_idx = "down", k
                        break

                if breakout_dir:
                    tightness = 1 - min((zone_high - zone_low) / (atr * 1.4), 1.0)
                    zones.append({
                        "zone_low": zone_low,
                        "zone_high": zone_high,
                        "mid": (zone_low + zone_high) / 2,
                        # Breakout ขึ้น -> ฐานเดิมกลายเป็น Demand Zone (แนวรับที่คาดว่าจะกลับมาทดสอบ)
                        # Breakout ลง -> ฐานเดิมกลายเป็น Supply Zone (แนวต้าน)
                        "type": "demand" if breakout_dir == "up" else "supply",
                        "bars": seg_end - seg_start + 1,
                        "tightness": tightness,
                        "last_idx": breakout_idx,
                    })
            i = j
        else:
            i += 1
    return zones


# ---------------------------------------------------------------------------
# C. Psychological Levels — เลขกลม (ปรับค่าได้)
# ---------------------------------------------------------------------------
def detect_psychological_levels(current_price: float, psych_step: Optional[float] = None, span_pct: float = 0.12):
    if psych_step and psych_step > 0:
        major = float(psych_step)
    else:
        major = next((s for s in DEFAULT_MAJOR_STEPS if current_price >= s * 3), 1)
        major = max(float(major), 1.0)

    minor = major / 4  # ครอบคลุมจุดย่อยแบบ 00 / 25 / 50 / 75 ของ major step
    lo, hi = current_price * (1 - span_pct), current_price * (1 + span_pct)

    levels = []
    v = math.floor(lo / major) * major
    while v <= hi:
        if v > 0:
            levels.append({"price": v, "kind": "major"})
        v += major

    v = math.floor(lo / minor) * minor
    while v <= hi:
        if v > 0 and abs((v / major) - round(v / major)) > 1e-6:
            levels.append({"price": v, "kind": "minor"})
        v += minor

    return levels


# ---------------------------------------------------------------------------
# D. Orderbook Approximation — Volume Profile (ไม่มี Order Book จริง)
# ---------------------------------------------------------------------------
def build_volume_profile(df: pd.DataFrame, bins: int = 24):
    if "Volume" not in df.columns or df["Volume"].fillna(0).sum() <= 0:
        return None

    highs, lows, vols = df["High"].values, df["Low"].values, df["Volume"].fillna(0).values
    price_min, price_max = float(lows.min()), float(highs.max())
    if price_max <= price_min:
        return None

    edges = np.linspace(price_min, price_max, bins + 1)
    vol_by_bin = np.zeros(bins)
    for h, l, v in zip(highs, lows, vols):
        if v <= 0:
            continue
        lo_bin = max(0, min(int(np.searchsorted(edges, l, side="right") - 1), bins - 1))
        hi_bin = max(0, min(int(np.searchsorted(edges, h, side="right") - 1), bins - 1))
        if hi_bin < lo_bin:
            lo_bin, hi_bin = hi_bin, lo_bin
        span = hi_bin - lo_bin + 1
        for b in range(lo_bin, hi_bin + 1):
            vol_by_bin[b] += v / span

    max_vol = vol_by_bin.max() if vol_by_bin.max() > 0 else 1.0
    return {"edges": edges, "vol_norm": vol_by_bin / max_vol}


def _volume_score_at(profile, price: float) -> float:
    if not profile:
        return 0.0
    edges, vol_norm = profile["edges"], profile["vol_norm"]
    idx = max(0, min(int(np.searchsorted(edges, price, side="right") - 1), len(vol_norm) - 1))
    return float(vol_norm[idx])


# ---------------------------------------------------------------------------
# F. EMA Confluence — เส้น EMA แบบ Dynamic S/R (สายยาวมีน้ำหนักมากกว่าสายสั้น)
# ---------------------------------------------------------------------------
EMA_PERIOD_WEIGHT = {20: 55.0, 50: 72.0, 100: 86.0, 200: 100.0}


def compute_ema_values(df: pd.DataFrame) -> dict:
    """คำนวณค่า EMA ล่าสุดของแต่ละคาบ (คำนวณครั้งเดียวใช้ซ้ำได้ทุกโซน)"""
    closes = df["Close"]
    values = {}
    for period in EMA_PERIOD_WEIGHT:
        if len(closes) < max(period // 2, 5):  # ข้อมูลน้อยเกินไปจน EMA ยาวๆ ไม่มีความหมาย
            continue
        values[period] = float(closes.ewm(span=period, adjust=False).mean().iloc[-1])
    return values


def ema_confluence_at(ema_values: dict, price: float, tolerance: float):
    """หาเส้น EMA ที่ราคาปัจจุบันของโซนนี้ใกล้ที่สุด (ภายใน tolerance) แล้วให้คะแนนตามสาย
    ถ้าตรงกับหลายเส้นพร้อมกัน (เช่น EMA50 ชนกับ EMA100) ยิ่งมีนัยสำคัญ จึงให้โบนัสเพิ่ม"""
    matched = [p for p, v in ema_values.items() if abs(v - price) <= tolerance]
    if not matched:
        return 0.0, []
    best_period = max(matched, key=lambda p: EMA_PERIOD_WEIGHT[p])
    score = EMA_PERIOD_WEIGHT[best_period]
    if len(matched) > 1:
        score = min(score + 8.0 * (len(matched) - 1), 100.0)  # หลายเส้นซ้อนกัน = จุดรวมเทรนด์ (โบนัส)
    return score, sorted(matched)


# ---------------------------------------------------------------------------
# E. รวมทุกปัจจัย + ให้คะแนน Strength 0-100 ต่อโซน
# ---------------------------------------------------------------------------
def compute_smart_levels(df: pd.DataFrame, current_price: float, atr: Optional[float],
                          psych_step: Optional[float] = None, max_levels: int = 4):
    n = len(df)
    if df is None or n < 5 or current_price <= 0:
        return [], []

    tolerance = _dynamic_tolerance(current_price, atr)
    support_wick, resistance_wick = detect_wick_footprint(df, tolerance)
    base_zones = detect_base_accumulation(df, atr)
    psych_levels = detect_psychological_levels(current_price, psych_step)
    vol_profile = build_volume_profile(df)
    ema_values = compute_ema_values(df)

    candidates = []
    for c in support_wick:
        candidates.append({"price": c["price"], "source": "wick", "touches": c["count"],
                            "last_idx": c["last_idx"], "side": "support"})
    for c in resistance_wick:
        candidates.append({"price": c["price"], "source": "wick", "touches": c["count"],
                            "last_idx": c["last_idx"], "side": "resistance"})
    for z in base_zones:
        side = "support" if z["type"] == "demand" else "resistance"
        candidates.append({"price": z["mid"], "source": "base", "touches": 0,
                            "last_idx": z["last_idx"], "side": side, "base": z})

    if not candidates and not psych_levels and not ema_values:
        return [], []

    # --- รวมกลุ่มราคาที่ใกล้กัน (wick + base) เข้าเป็นโซนเดียวกัน ---
    order = sorted(range(len(candidates)), key=lambda i: candidates[i]["price"])
    used = [False] * len(candidates)
    merged_groups = []
    for idx in order:
        if used[idx]:
            continue
        group = [candidates[idx]]
        used[idx] = True
        for jdx in order:
            if used[jdx]:
                continue
            if abs(candidates[jdx]["price"] - candidates[idx]["price"]) <= tolerance:
                group.append(candidates[jdx])
                used[jdx] = True
        merged_groups.append(group)

    # --- โซนที่เกิดจาก EMA ล้วนๆ (ไม่มี Wick/Base ใกล้ๆ เลย) ก็ต้องถูกพิจารณาเป็นผู้สมัครด้วย
    # เพราะ EMA200/EMA50 มักเป็นแนวรับ-ต้านที่แข็งแรงอยู่แล้วแม้จะยังไม่มี Wick มายืนยันซ้ำ
    ema_only_prices = []
    for period, val in ema_values.items():
        if any(abs(val - c["price"]) <= tolerance for c in candidates):
            continue
        ema_only_prices.append(val)

    zones = []

    def score_zone(price, touches, has_base, base_info, last_idx, side):
        # --- ปัจจัยเด่น (Primary factors) — คิดแยกกัน ไม่บังคับให้ต้องมีครบทุกตัว ---
        touch_score = min(touches, 6) / 6 * 100 if touches else 0.0  # 6 ครั้งขึ้นไป = เต็มสเกล (absolute ไม่ใช่ relative)
        base_score = 0.0
        if has_base:
            bars_component = min(base_info["bars"], 12) / 12
            base_score = (0.5 * bars_component + 0.5 * base_info["tightness"]) * 100
        ema_score, matched_ema = ema_confluence_at(ema_values, price, tolerance)

        primary_scores = {"touch": touch_score, "base": base_score, "ema": ema_score}
        primary = max(primary_scores.values())

        # --- ปัจจัยเสริม (Confirming factors) — ให้เป็น "โบนัส" ทับปัจจัยเด่น แทนการเฉลี่ยรวม ---
        matched_psych = None
        for pl in psych_levels:
            if abs(pl["price"] - price) <= tolerance:
                matched_psych = pl
                break
        psych_bonus = 0.0
        if matched_psych:
            psych_bonus = 16.0 if matched_psych["kind"] == "major" else 8.0

        vol_score = _volume_score_at(vol_profile, price) * 100
        vol_bonus = 0.0
        if vol_profile is not None and vol_score >= 45:
            vol_bonus = min((vol_score - 45) / 55 * 14, 14.0)

        # ยิ่งมีปัจจัยหลักหลายตัว "ยืนยันซ้ำ" กันในโซนเดียวกัน (ไม่ใช่แค่ตัวที่แรงสุด) ยิ่งน่าเชื่อขึ้น
        strong_supporters = sum(1 for v in primary_scores.values() if v >= 40)
        confluence_bonus = max(strong_supporters - 1, 0) * 9.0

        recency_factor = 0.85 + 0.15 * (last_idx / max(n - 1, 1)) if last_idx is not None else 0.9

        raw = (primary + psych_bonus + vol_bonus + confluence_bonus) * recency_factor
        strength = round(min(max(raw, 0.0), 100.0), 1)

        if strength >= 75:
            confidence = "High Confidence"
        elif strength >= 45:
            confidence = "Medium"
        else:
            confidence = "Weak"

        reasons = []
        if touches:
            reasons.append(f"Wick Footprint: โดน Reject ซ้ำ {touches} ครั้ง")
        if has_base:
            zone_kind = "Demand Zone" if base_info["type"] == "demand" else "Supply Zone"
            reasons.append(f"Base Accumulation: สะสมฐาน {base_info['bars']} แท่ง -> {zone_kind}")
        if matched_ema:
            ema_txt = ", ".join(f"EMA{p}" for p in matched_ema)
            reasons.append(f"EMA Confluence: ใกล้เส้น {ema_txt} (แนวรับ-ต้านแบบ Dynamic ที่เทรนด์จับตา)")
        if matched_psych:
            kind_txt = "เลขกลมหลัก" if matched_psych["kind"] == "major" else "เลขกลมย่อย"
            reasons.append(f"Psychological Level: {kind_txt} ${matched_psych['price']:.2f}")
        if vol_profile is not None and vol_score >= 40:
            reasons.append(f"Volume Profile: สภาพคล่องสูง (≈{vol_score:.0f}%)")
        elif vol_profile is None:
            reasons.append("Volume Profile: ไม่มีข้อมูล ใช้ Wick + Price Action ประมาณแทน")
        if not reasons:
            reasons.append("Price Action ทั่วไป (สัญญาณอ่อน)")

        return strength, confidence, reasons

    for group in merged_groups:
        votes = {"support": 0, "resistance": 0}
        for g in group:
            votes[g["side"]] += 1
        side = "support" if votes["support"] >= votes["resistance"] else "resistance"

        touches = sum(g.get("touches", 0) for g in group)
        wick_prices = [g["price"] for g in group if g["source"] == "wick"]
        base_group = [g for g in group if g["source"] == "base"]
        has_base = len(base_group) > 0
        price = (sum(wick_prices) / len(wick_prices)) if wick_prices else (sum(g["price"] for g in group) / len(group))
        last_idx = max(g.get("last_idx", 0) or 0 for g in group)

        zone_low = zone_high = None
        base_info = base_group[0]["base"] if has_base else None
        if has_base:
            zone_low, zone_high = base_info["zone_low"], base_info["zone_high"]

        strength, confidence, reasons = score_zone(price, touches, has_base, base_info, last_idx, side)

        zones.append({
            "price": round(float(price), 2),
            "side": side,
            "strength": strength,
            "confidence": confidence,
            "reasons": reasons,
            "zone_low": round(zone_low, 2) if zone_low is not None else None,
            "zone_high": round(zone_high, 2) if zone_high is not None else None,
        })

    # --- โซนที่มาจาก EMA ล้วนๆ (ไม่มี Wick/Base ยืนยัน) ---
    # เช่น EMA200/EMA50 บนกราฟ Week ที่ราคายังไม่เคยเทสต์ตรงๆ แต่ก็ยังเป็นแนวรับ-ต้าน Dynamic ที่มีนัยสำคัญ
    for val in ema_only_prices:
        side = "support" if val < current_price else "resistance"
        strength, confidence, reasons = score_zone(val, 0, False, None, n - 1, side)
        zones.append({
            "price": round(float(val), 2),
            "side": side,
            "strength": strength,
            "confidence": confidence,
            "reasons": reasons,
            "zone_low": None,
            "zone_high": None,
        })

    # --- เติมเลขกลมที่ยังไม่มีการยืนยันจาก Wick/Base/EMA เข้าไปเป็นตัวเลือกสำรอง (คะแนนต่ำกว่า) ---
    existing_prices = [z["price"] for z in zones]
    for pl in psych_levels:
        if any(abs(pl["price"] - ep) <= tolerance for ep in existing_prices):
            continue
        if pl["price"] == current_price:
            continue
        side = "support" if pl["price"] < current_price else "resistance"
        base_strength = 48.0 if pl["kind"] == "major" else 24.0
        kind_txt = "เลขกลมหลัก" if pl["kind"] == "major" else "เลขกลมย่อย"
        zones.append({
            "price": round(float(pl["price"]), 2),
            "side": side,
            "strength": base_strength,
            "confidence": "Medium" if base_strength >= 45 else "Weak",
            "reasons": [f"Psychological Level: {kind_txt} ${pl['price']:.2f} (ยังไม่มี Wick/Base/EMA ยืนยัน)"],
            "zone_low": None,
            "zone_high": None,
        })

    supports = [z for z in zones if z["price"] < current_price]
    resistances = [z for z in zones if z["price"] > current_price]

    # เอาโซนที่คะแนนสูงสุดก่อน แล้วเรียงตามความใกล้ราคาปัจจุบันเพื่อแสดงผลเป็นบันได
    supports = sorted(supports, key=lambda z: (-z["strength"], current_price - z["price"]))[:max_levels * 2]
    resistances = sorted(resistances, key=lambda z: (-z["strength"], z["price"] - current_price))[:max_levels * 2]
    supports = sorted(supports, key=lambda z: current_price - z["price"])[:max_levels]
    resistances = sorted(resistances, key=lambda z: z["price"] - current_price)[:max_levels]

    return supports, resistances