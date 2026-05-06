"""
market_reaction.py
記事公開時刻 ±30分の市場反応を yfinance から取得して返す。
キャッシュは data/market_reaction/{YYYY-MM}.jsonl に追記保存。
"""

import hashlib
import json
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

try:
    import yfinance as yf
    import pandas as pd
    YFINANCE_OK = True
except ImportError:
    YFINANCE_OK = False

DATA_DIR = Path(__file__).parent / "data" / "market_reaction"

# カテゴリ別の対象指標マッピング
CATEGORY_SYMBOLS: dict[str, list[str]] = {
    "jp_stock":      ["^N225", "^TPX"],
    "jp_index":      ["^N225", "^TPX"],
    "foreign_stock": ["^GSPC", "^IXIC"],
    "foreign_index": ["^GSPC", "^IXIC"],
    "futures":       ["NKD=F", "ES=F"],
    "fx_macro":      ["USDJPY=X", "^TNX"],
}

# 日本の市場セッション (JST)
JP_MARKET_OPEN  = (9, 0)   # 09:00 JST
JP_MARKET_CLOSE = (15, 30) # 15:30 JST

# 米国の市場セッション (ET = UTC-5 / UTC-4)
US_MARKET_OPEN  = (9, 30)  # 09:30 ET
US_MARKET_CLOSE = (16, 0)  # 16:00 ET

# abs_change_pct → reaction_score (0-10) のスケール変換テーブル
# (閾値, スコア) のリスト。閾値以上の最初の項目を使う。
REACTION_SCALE = [
    (2.0, 10.0),
    (1.5, 9.0),
    (1.0, 7.0),
    (0.7, 6.0),
    (0.5, 5.0),
    (0.3, 3.0),
    (0.1, 1.5),
    (0.0, 0.0),
]


def _article_id(url: str) -> str:
    """URL の MD5 ハッシュをキーとして使用。"""
    return hashlib.md5(url.encode()).hexdigest()


def _load_cache(ym: str) -> dict:
    """YYYY-MM の JSONL キャッシュを読み込んで article_id → dict の辞書を返す。"""
    path = DATA_DIR / f"{ym}.jsonl"
    result: dict = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            aid = entry.get("article_id")
            if aid:
                result[aid] = entry
        except Exception:
            pass
    return result


def _append_cache(ym: str, entry: dict) -> None:
    """YYYY-MM の JSONL に 1 行追記。article_id で重複排除はしない（ロード時に上書き）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{ym}.jsonl"
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _scale_reaction(abs_pct: float) -> float:
    """abs_change_pct (%) を 0-10 にスケール変換。"""
    for threshold, score in REACTION_SCALE:
        if abs_pct >= threshold:
            # 線形補間
            idx = REACTION_SCALE.index((threshold, score))
            if idx == 0:
                return 10.0
            prev_thresh, prev_score = REACTION_SCALE[idx - 1]
            if prev_thresh == threshold:
                return score
            ratio = (abs_pct - threshold) / (prev_thresh - threshold)
            return round(score + ratio * (prev_score - score), 2)
    return 0.0


def _is_market_hours(dt_utc: datetime, symbol: str) -> bool:
    """UTC 日時が当該シンボルの市場時間内かどうか。"""
    if symbol in ("^N225", "^TPX", "NKD=F"):
        # JST = UTC+9
        dt_local = dt_utc + timedelta(hours=9)
        h, m = dt_local.hour, dt_local.minute
        open_min  = JP_MARKET_OPEN[0]  * 60 + JP_MARKET_OPEN[1]
        close_min = JP_MARKET_CLOSE[0] * 60 + JP_MARKET_CLOSE[1]
        cur_min   = h * 60 + m
        # 月〜金のみ
        if dt_local.weekday() >= 5:
            return False
        return open_min <= cur_min <= close_min
    else:
        # ET = UTC-4 (夏時間) or UTC-5 (冬時間): 近似 UTC-4 を使用
        dt_et = dt_utc - timedelta(hours=4)
        h, m = dt_et.hour, dt_et.minute
        open_min  = US_MARKET_OPEN[0]  * 60 + US_MARKET_OPEN[1]
        close_min = US_MARKET_CLOSE[0] * 60 + US_MARKET_CLOSE[1]
        cur_min   = h * 60 + m
        if dt_et.weekday() >= 5:
            return False
        return open_min <= cur_min <= close_min


def _next_market_open(dt_utc: datetime, symbol: str) -> datetime:
    """市場時間外公開の場合、次の開場時刻（UTC）を返す。"""
    if symbol in ("^N225", "^TPX", "NKD=F"):
        # JST 09:00 を UTC に変換
        dt_jst = dt_utc + timedelta(hours=9)
        candidate = dt_jst.replace(hour=JP_MARKET_OPEN[0], minute=JP_MARKET_OPEN[1], second=0, microsecond=0)
        if candidate <= dt_jst:
            candidate += timedelta(days=1)
        # 週末をスキップ
        while candidate.weekday() >= 5:
            candidate += timedelta(days=1)
        return candidate - timedelta(hours=9)  # UTC に戻す
    else:
        # ET 09:30 → UTC (ET+4)
        dt_et = dt_utc - timedelta(hours=4)
        candidate = dt_et.replace(hour=US_MARKET_OPEN[0], minute=US_MARKET_OPEN[1], second=0, microsecond=0)
        if candidate <= dt_et:
            candidate += timedelta(days=1)
        while candidate.weekday() >= 5:
            candidate += timedelta(days=1)
        return candidate + timedelta(hours=4)


def _fetch_price_window(symbol: str, center_utc: datetime, window_minutes: int = 30,
                         max_retries: int = 3) -> Optional[tuple[float, float]]:
    """
    center_utc を中心とした ±window_minutes の期間で
    開始価格（before）と終了価格（after）を返す。
    失敗時は None。
    """
    if not YFINANCE_OK:
        return None

    now = datetime.now(timezone.utc)
    age_days = (now - center_utc).days

    # データ解像度の選択
    if age_days <= 7:
        interval = "1m"
        period_days = 8
    elif age_days <= 60:
        interval = "5m"
        period_days = 62
    else:
        interval = "1h"
        period_days = min(age_days + 5, 729)

    start = center_utc - timedelta(minutes=window_minutes)
    end   = min(center_utc + timedelta(minutes=window_minutes), now)

    ticker = yf.Ticker(symbol)

    for attempt in range(max_retries):
        try:
            df = ticker.history(
                start=start.strftime("%Y-%m-%d"),
                end=(end + timedelta(days=1)).strftime("%Y-%m-%d"),
                interval=interval,
                auto_adjust=True,
            )
            if df is None or df.empty:
                time.sleep(1)
                continue

            # タイムゾーン統一
            if df.index.tzinfo is None:
                df.index = df.index.tz_localize("UTC")
            else:
                df.index = df.index.tz_convert("UTC")

            # ウィンドウ内に絞る
            mask = (df.index >= start) & (df.index <= end)
            window_df = df[mask]

            if len(window_df) < 2:
                # フォールバック: 解像度を下げて再試行
                if interval == "1m":
                    interval = "5m"
                elif interval == "5m":
                    interval = "1h"
                time.sleep(1)
                continue

            before_price = float(window_df["Close"].iloc[0])
            after_price  = float(window_df["Close"].iloc[-1])
            return before_price, after_price

        except Exception as e:
            print(f"  [WARN] market_reaction yfinance ({symbol}, attempt {attempt+1}): {e}")
            time.sleep(2 ** attempt)

    return None


def fetch_market_reaction(
    article_published_at: str,
    category: str,
    article_url: str = "",
) -> dict:
    """
    記事公開時刻 ±30分の市場反応を取得。

    Args:
        article_published_at: ISO 8601 文字列 (例: "2026-05-06T09:30:00+00:00")
        category: 6カテゴリのいずれか
        article_url: キャッシュキーに使用（省略時は published_at + category でハッシュ）

    Returns:
        {
            "indicator": str,
            "indicator_name": str,
            "before_price": float,
            "after_price": float,
            "change_pct": float,
            "abs_change_pct": float,
            "reaction_score": float,
            "data_quality": "good" | "limited" | "unavailable",
            "note": str,
        }
    """
    unavailable = {
        "indicator": "",
        "indicator_name": "",
        "before_price": 0.0,
        "after_price": 0.0,
        "change_pct": 0.0,
        "abs_change_pct": 0.0,
        "reaction_score": 0.0,
        "data_quality": "unavailable",
        "note": "",
    }

    if not YFINANCE_OK:
        return {**unavailable, "note": "yfinance未インストール"}

    # 公開日時をパース
    try:
        if article_published_at.endswith("Z"):
            article_published_at = article_published_at[:-1] + "+00:00"
        pub_dt = datetime.fromisoformat(article_published_at)
        if pub_dt.tzinfo is None:
            pub_dt = pub_dt.replace(tzinfo=timezone.utc)
        pub_dt = pub_dt.astimezone(timezone.utc)
    except Exception as e:
        return {**unavailable, "note": f"日時パースエラー: {e}"}

    # 未来時刻チェック: 公開時刻が現在より先の場合はデータ取得不可
    now_check = datetime.now(timezone.utc)
    if pub_dt > now_check:
        return {
            **unavailable,
            "data_quality": "unavailable",
            "note": "公開時刻が未来のためデータ取得不可",
        }

    # キャッシュキー
    cache_key_src = article_url if article_url else f"{article_published_at}_{category}"
    aid = _article_id(cache_key_src)
    ym = pub_dt.strftime("%Y-%m")

    # キャッシュヒットチェック
    cache = _load_cache(ym)
    if aid in cache:
        return cache[aid]["reaction"]

    # カテゴリ別シンボル選択
    symbols = CATEGORY_SYMBOLS.get(category, ["^GSPC"])
    indicator_names = {
        "^N225":    "日経平均",
        "^TPX":     "TOPIX",
        "^GSPC":    "S&P500",
        "^IXIC":    "NASDAQ",
        "NKD=F":    "日経先物",
        "ES=F":     "S&P先物",
        "USDJPY=X": "ドル円",
        "^TNX":     "米10年債利回り",
    }

    # データ年齢の判定
    now_utc = datetime.now(timezone.utc)
    age_days = (now_utc - pub_dt).days
    data_quality = "good" if age_days <= 7 else ("limited" if age_days <= 60 else "limited")

    for symbol in symbols:
        # 市場時間外チェック
        note = ""
        measure_dt = pub_dt
        if not _is_market_hours(pub_dt, symbol):
            measure_dt = _next_market_open(pub_dt, symbol)
            note = "市場時間外公開"

        result = _fetch_price_window(symbol, measure_dt, window_minutes=30)
        if result is None:
            continue  # 次のシンボルへ

        before_price, after_price = result
        if before_price == 0:
            continue

        change_pct     = round((after_price - before_price) / before_price * 100, 4)
        abs_change_pct = abs(change_pct)
        reaction_score = _scale_reaction(abs_change_pct)

        reaction = {
            "indicator":       symbol,
            "indicator_name":  indicator_names.get(symbol, symbol),
            "before_price":    round(before_price, 4),
            "after_price":     round(after_price, 4),
            "change_pct":      change_pct,
            "abs_change_pct":  abs_change_pct,
            "reaction_score":  reaction_score,
            "data_quality":    data_quality,
            "note":            note,
        }

        # キャッシュ保存
        entry = {
            "article_id":  aid,
            "published_at": article_published_at,
            "category":    category,
            "reaction":    reaction,
        }
        try:
            _append_cache(ym, entry)
        except Exception as e:
            print(f"  [WARN] market_reaction cache write: {e}")

        return reaction

    # 全シンボル失敗
    failed = {**unavailable, "note": f"全シンボル取得失敗 ({', '.join(symbols)})"}
    entry = {
        "article_id":  aid,
        "published_at": article_published_at,
        "category":    category,
        "reaction":    failed,
    }
    try:
        _append_cache(ym, entry)
    except Exception:
        pass
    return failed
