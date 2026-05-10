"""
daily_stats.py
日経225の統計分析モジュール。

- load_historical_data(): nikkei.json を読み込む
- update_historical_data(): yfinance で最新データを追記
- compute_daily_stats(): 今日の変動を過去30年と比較分析
"""

from __future__ import annotations

import json
import math
import statistics
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

DATA_DIR = Path(__file__).parent / "data"
NIKKEI_JSON = DATA_DIR / "historical_daily" / "nikkei.json"
JST = timezone(timedelta(hours=9))

# ── 重要イベント辞書（日付 → ラベル）──────────────────────
# 判定: 対象日の前後30営業日以内にある最初のエントリを採用
_EVENTS: list[tuple[str, str, str]] = [
    # (start_date, end_date, label)
    ("2008-09-01", "2009-03-31", "リーマンショック"),
    ("2011-03-11", "2011-06-30", "東日本大震災"),
    ("2020-02-01", "2020-04-30", "コロナショック"),
    ("2016-11-01", "2016-11-30", "トランプ当選"),
    ("2022-02-24", "2022-03-31", "ウクライナ侵攻"),
    ("2015-08-01", "2015-09-30", "チャイナショック"),
    ("2013-05-01", "2013-06-30", "バーナンキショック"),
    ("2024-08-01", "2024-08-15", "令和ブラックマンデー"),
    ("2023-03-01", "2023-03-31", "SVB破綻"),
    ("1997-10-01", "1998-01-31", "アジア通貨危機"),
    ("2000-03-01", "2002-12-31", "ITバブル崩壊"),
    ("2007-07-01", "2007-09-30", "サブプライム危機"),
    ("2012-11-01", "2012-12-31", "アベノミクス開始"),
    ("2016-06-23", "2016-07-10", "Brexit"),
    ("2018-12-01", "2018-12-31", "クリスマスショック"),
    ("2021-11-01", "2021-12-31", "オミクロン株"),
    ("2022-09-01", "2022-10-31", "英国財政危機"),
    ("2023-10-01", "2023-10-31", "中東紛争激化"),
]


def _get_event_context(date_str: str) -> str:
    """日付文字列に対応するイベントラベルを返す。なければ空文字。"""
    for start, end, label in _EVENTS:
        if start <= date_str <= end:
            return label
    return ""


def load_historical_data() -> list[dict]:
    """nikkei.json を読み込む。存在しなければ空リスト。"""
    if not NIKKEI_JSON.exists():
        return []
    try:
        return json.loads(NIKKEI_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []


def update_historical_data() -> int:
    """
    yfinance で ^N225 の最新データを取得して nikkei.json を更新。
    戻り値: 保存したレコード数。
    """
    try:
        import yfinance as yf
        import math as _math
    except ImportError:
        print("[daily_stats] yfinance が必要です: pip install yfinance")
        return 0

    existing = {r["date"]: r for r in load_historical_data()}

    ticker = yf.Ticker("^N225")
    hist = ticker.history(period="30y")

    for ts, row in hist.iterrows():
        c = row.get("Close")
        v = row.get("Volume")
        if c is None or (isinstance(c, float) and _math.isnan(c)):
            continue
        d = ts.strftime("%Y-%m-%d")
        existing[d] = {
            "date": d,
            "close": round(float(c), 2),
            "volume": int(v) if v is not None and not (isinstance(v, float) and _math.isnan(v)) else 0,
        }

    records = sorted(existing.values(), key=lambda x: x["date"])
    NIKKEI_JSON.parent.mkdir(parents=True, exist_ok=True)
    NIKKEI_JSON.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    print(f"[daily_stats] nikkei.json 更新: {len(records)} 件")
    return len(records)


def _safe(v) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def compute_daily_stats(
    today_close: float,
    prev_close: float,
    today_volume: int = 0,
    historical: Optional[list[dict]] = None,
) -> dict:
    """
    今日の終値・出来高と過去30年データを比較して統計指標を返す。

    Args:
        today_close:  今日の終値
        prev_close:   前日終値
        today_volume: 今日の出来高（0 でも可）
        historical:   nikkei.json のレコードリスト（省略時は自動読み込み）

    Returns:
        統計 dict（テンプレートに渡す全指標）
    """
    if historical is None:
        historical = load_historical_data()

    if not historical or prev_close == 0:
        return {}

    today_close = float(today_close)
    prev_close = float(prev_close)
    change_pct = (today_close - prev_close) / prev_close * 100

    # ── 日次変動率リストを構築 ─────────────────────────────
    closes = [r["close"] for r in historical if r.get("close")]
    volumes = [r.get("volume", 0) for r in historical]
    dates = [r["date"] for r in historical]

    daily_changes: list[float] = []
    daily_volumes: list[int] = []
    daily_dates: list[str] = []

    for i in range(1, len(closes)):
        pc = closes[i - 1]
        cc = closes[i]
        if pc and pc != 0:
            pct = (cc - pc) / pc * 100
            daily_changes.append(pct)
            daily_volumes.append(volumes[i])
            daily_dates.append(dates[i])

    if not daily_changes:
        return {}

    n = len(daily_changes)

    # ── パーセンタイル ──────────────────────────────────────
    sorted_changes = sorted(daily_changes)
    rank = sum(1 for v in sorted_changes if v <= change_pct)
    percentile = round(rank / n * 100, 1)

    # ── シグマ ──────────────────────────────────────────────
    mu = statistics.mean(daily_changes)
    sigma_val = statistics.stdev(daily_changes)
    sigma = round((change_pct - mu) / sigma_val, 2) if sigma_val > 0 else 0.0

    # ── 異常判定 ──────────────────────────────────────────────
    abs_sigma = abs(sigma)
    if abs_sigma >= 3:
        anomaly_level = "extreme"
        is_anomaly = True
    elif abs_sigma >= 2:
        anomaly_level = "warning"
        is_anomaly = True
    else:
        anomaly_level = "normal"
        is_anomaly = False

    # ── 出来高比（30日平均比） ──────────────────────────────
    vol_30d = [v for v in daily_volumes[-30:] if v > 0]
    vol_avg_30d = statistics.mean(vol_30d) if vol_30d else 0
    volume_ratio = round(today_volume / vol_avg_30d * 100, 1) if vol_avg_30d > 0 else 100.0
    volume_anomaly = volume_ratio > 200 or (volume_ratio < 50 and today_volume > 0)

    # ── 年初来高値・安値 ──────────────────────────────────────
    this_year = str(datetime.now(JST).year)
    ytd_closes = [closes[i] for i, d in enumerate(dates) if d.startswith(this_year)]
    year_high = max(ytd_closes) if ytd_closes else today_close
    year_low = min(ytd_closes) if ytd_closes else today_close
    from_high_pct = round((today_close - year_high) / year_high * 100, 2) if year_high else 0.0
    from_low_pct = round((today_close - year_low) / year_low * 100, 2) if year_low else 0.0

    # ── 類似日分析 ──────────────────────────────────────────
    # 変動率の「幅」: 0.5% ずつ
    band = 0.5
    low_bound = math.floor(change_pct / band) * band
    high_bound = low_bound + band

    similar_indices: list[int] = []
    for i, ch in enumerate(daily_changes):
        if low_bound <= ch < high_bound:
            similar_indices.append(i)

    sample_size = len(similar_indices)
    range_label = f"{low_bound:+.1f}%〜{high_bound:+.1f}%"

    # 5日後・30日後・90日後のリターン計算
    future_returns_5d: list[float] = []
    future_returns_30d: list[float] = []
    future_returns_90d: list[float] = []

    for idx in similar_indices:
        base_close_idx = idx  # daily_changes[idx] は closes[idx+1] の変化率
        actual_close_idx = idx + 1  # closes の index

        for future_days, returns_list in [(5, future_returns_5d), (30, future_returns_30d), (90, future_returns_90d)]:
            future_idx = actual_close_idx + future_days
            if future_idx < len(closes):
                base = closes[actual_close_idx]
                future = closes[future_idx]
                if base > 0:
                    r = (future - base) / base * 100
                    returns_list.append(r)

    def _avg(lst: list[float]) -> Optional[float]:
        return round(statistics.mean(lst), 2) if lst else None

    def _win_rate(lst: list[float]) -> Optional[float]:
        if not lst:
            return None
        return round(sum(1 for v in lst if v > 0) / len(lst) * 100, 1)

    return_5d = _avg(future_returns_5d)
    return_30d = _avg(future_returns_30d)
    return_90d = _avg(future_returns_90d)
    win_rate_30d = _win_rate(future_returns_30d)

    # ── 具体的な類似日トップ3（30日後リターンの大きい順） ──
    top_examples: list[dict] = []
    if similar_indices:
        examples_data: list[tuple[float, dict]] = []
        for idx in similar_indices:
            actual_close_idx = idx + 1
            future_idx_30 = actual_close_idx + 30
            future_idx_90 = actual_close_idx + 90
            if future_idx_30 >= len(closes):
                continue
            base = closes[actual_close_idx]
            r30 = (closes[future_idx_30] - base) / base * 100 if base > 0 else 0
            r90 = (closes[future_idx_90] - base) / base * 100 if future_idx_90 < len(closes) and base > 0 else None

            d = daily_dates[idx]
            context = _get_event_context(d)
            examples_data.append((abs(r30), {
                "date": d,
                "change": round(daily_changes[idx], 2),
                "return_30d": round(r30, 1),
                "return_90d": round(r90, 1) if r90 is not None else None,
                "context": context,
            }))

        # 絶対リターンが大きい順に3件（インパクトのある事例を優先）
        examples_data.sort(key=lambda x: x[0], reverse=True)
        top_examples = [e for _, e in examples_data[:3]]

    # ── 異常変動アラート用: 同等以上の極端な日数 ─────────────
    if sigma >= 0:
        extreme_count = sum(1 for ch in daily_changes if (ch - mu) / sigma_val >= abs_sigma) if sigma_val > 0 else 0
    else:
        extreme_count = sum(1 for ch in daily_changes if (ch - mu) / sigma_val <= -abs_sigma) if sigma_val > 0 else 0

    # 上位 / 下位パーセンタイル文字列
    if percentile >= 50:
        percentile_str = f"上位{round(100 - percentile, 1)}%"
    else:
        percentile_str = f"下位{round(percentile, 1)}%"

    return {
        "change_pct": round(change_pct, 2),
        "percentile": percentile,
        "percentile_str": percentile_str,
        "sigma": sigma,
        "is_anomaly": is_anomaly,
        "anomaly_level": anomaly_level,
        "volume_ratio": volume_ratio,
        "volume_anomaly": volume_anomaly,
        "similar_days": {
            "range": range_label,
            "sample_size": sample_size,
            "return_5d": return_5d,
            "return_30d": return_30d,
            "return_90d": return_90d,
            "win_rate_30d": win_rate_30d,
            "top_examples": top_examples,
        },
        "year_high": round(year_high, 2),
        "year_low": round(year_low, 2),
        "from_high_pct": from_high_pct,
        "from_low_pct": from_low_pct,
        "extreme_count": extreme_count,
        "total_days": n,
    }


if __name__ == "__main__":
    import sys

    data = load_historical_data()
    if len(data) < 2:
        print("データが不足しています。update_historical_data() を実行してください。")
        sys.exit(1)

    latest = data[-1]
    prev = data[-2]
    print(f"最新データ: {latest['date']} close={latest['close']}")
    print(f"前日データ: {prev['date']} close={prev['close']}")
    print()

    result = compute_daily_stats(
        today_close=latest["close"],
        prev_close=prev["close"],
        today_volume=latest.get("volume", 0),
        historical=data,
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))
