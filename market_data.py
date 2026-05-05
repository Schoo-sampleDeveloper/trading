"""
market_data.py
Yahoo Finance から指数データを取得し、キャッシュ・履歴管理を行う。

TODO: 複数指数対応
  main.py で fetch_index_data を複数銘柄ループ実行し、
  market_data dict に {"nikkei": ..., "topix": ..., "sp500": ..., "usdjpy": ...} で渡す。
  テンプレートはタブUIで切り替え可能に。
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))

DATA_DIR = Path(__file__).parent / "data"
CACHE_DIR = DATA_DIR / "market_cache"
HISTORY_DIR = DATA_DIR / "market_history"

# 5年を超えた古いデータを削除
MAX_HISTORY_YEARS = 5

# 指数の表示名マッピング
INDEX_NAMES: dict[str, str] = {
    "^N225": "日経平均株価",
    "^TPX": "TOPIX",
    "^GSPC": "S&P 500",
    "^IXIC": "NASDAQ",
    "^DJI": "ダウ平均",
    "USDJPY=X": "ドル円",
}

INDEX_CURRENCIES: dict[str, str] = {
    "^N225": "JPY",
    "^TPX": "JPY",
    "^GSPC": "USD",
    "^IXIC": "USD",
    "^DJI": "USD",
    "USDJPY=X": "JPY",
}


def _jst_now() -> datetime:
    return datetime.now(JST)


def _safe_float(v) -> Optional[float]:
    """NaN / None / inf を None に変換して返す。"""
    if v is None:
        return None
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(f, 4)
    except (TypeError, ValueError):
        return None


def _calc_ma(closes: list[Optional[float]], window: int) -> list[Optional[float]]:
    """単純移動平均を計算する。計算不能な箇所は None。"""
    result: list[Optional[float]] = []
    for i, _ in enumerate(closes):
        if i < window - 1:
            result.append(None)
            continue
        segment = closes[i - window + 1 : i + 1]
        valid = [v for v in segment if v is not None]
        if len(valid) == window:
            result.append(round(sum(valid) / window, 4))
        else:
            result.append(None)
    return result


def fetch_index_data(symbol: str, period: str = "1y") -> Optional[dict]:
    """
    指数の時系列データを取得する。

    Args:
        symbol: Yahoo Finance のシンボル (例: "^N225")
        period: 取得期間 ("1mo", "3mo", "6mo", "1y", "2y", "5y")

    Returns:
        データ dict、または取得失敗時 None
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    cache_file = CACHE_DIR / f"{symbol.replace('^', '_').replace('=', '_')}.json"

    # 同日キャッシュがあればそれを返す
    today_str = _jst_now().strftime("%Y-%m-%d")
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            cached_date = cached.get("updated_at", "")[:10]
            if cached_date == today_str:
                logger.info(f"[market_data] キャッシュ使用: {symbol} ({cached_date})")
                return cached
        except Exception:
            pass

    # yfinance で取得
    try:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        hist = ticker.history(period=period)
        info = ticker.fast_info

        if hist.empty:
            logger.warning(f"[market_data] データ空: {symbol}")
            return _load_cache_fallback(cache_file, symbol)

        # OHLCV を dict リストに変換
        ohlc: list[dict] = []
        for ts, row in hist.iterrows():
            date_str = ts.strftime("%Y-%m-%d")
            o = _safe_float(row.get("Open"))
            h = _safe_float(row.get("High"))
            lo = _safe_float(row.get("Low"))
            c = _safe_float(row.get("Close"))
            v = _safe_float(row.get("Volume"))
            if c is not None:  # 終値がなければスキップ
                ohlc.append({
                    "date": date_str,
                    "open": o,
                    "high": h,
                    "low": lo,
                    "close": c,
                    "volume": int(v) if v is not None else 0,
                })

        # 日付昇順ソート
        ohlc.sort(key=lambda x: x["date"])

        closes = [r["close"] for r in ohlc]
        ma5 = _calc_ma(closes, 5)
        ma25 = _calc_ma(closes, 25)
        ma75 = _calc_ma(closes, 75)

        # 直近値
        current = _safe_float(getattr(info, "last_price", None)) or (closes[-1] if closes else None)
        prev_close = _safe_float(getattr(info, "previous_close", None))
        if prev_close is None and len(closes) >= 2:
            prev_close = closes[-2]

        change: Optional[float] = None
        change_pct: Optional[float] = None
        if current is not None and prev_close is not None and prev_close != 0:
            change = round(current - prev_close, 4)
            change_pct = round((current - prev_close) / prev_close * 100, 4)

        # 年初来高値・安値
        year_high: Optional[float] = _safe_float(getattr(info, "year_high", None))
        year_low: Optional[float] = _safe_float(getattr(info, "year_low", None))

        # 高値・安値の日付をhistから探す
        year_high_date: Optional[str] = None
        year_low_high_date: Optional[str] = None
        if year_high is not None:
            for r in reversed(ohlc):
                if r["high"] and abs(r["high"] - year_high) < 1:
                    year_high_date = r["date"]
                    break
        year_low_date: Optional[str] = None
        if year_low is not None:
            for r in reversed(ohlc):
                if r["low"] and abs(r["low"] - year_low) < 1:
                    year_low_date = r["date"]
                    break

        updated_at = _jst_now().strftime("%Y-%m-%dT%H:%M:%S+09:00")

        result = {
            "symbol": symbol,
            "name": INDEX_NAMES.get(symbol, symbol),
            "currency": INDEX_CURRENCIES.get(symbol, ""),
            "current": current,
            "previous_close": prev_close,
            "change": change,
            "change_percent": change_pct,
            "open": _safe_float(getattr(info, "open", None)) or (ohlc[-1]["open"] if ohlc else None),
            "day_high": _safe_float(getattr(info, "day_high", None)) or (ohlc[-1]["high"] if ohlc else None),
            "day_low": _safe_float(getattr(info, "day_low", None)) or (ohlc[-1]["low"] if ohlc else None),
            "year_high": year_high,
            "year_high_date": year_high_date,
            "year_low": year_low,
            "year_low_date": year_low_date,
            "fifty_two_week_high": year_high,
            "fifty_two_week_low": year_low,
            "ohlc": ohlc,
            "ma5": ma5,
            "ma25": ma25,
            "ma75": ma75,
            "updated_at": updated_at,
        }

        # キャッシュ保存
        cache_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"[market_data] 取得完了: {symbol} current={current} ({len(ohlc)}日分)")
        return result

    except ImportError:
        logger.error("[market_data] yfinance がインストールされていません: pip install yfinance")
        return _load_cache_fallback(cache_file, symbol)
    except Exception as e:
        logger.error(f"[market_data] 取得失敗 {symbol}: {e}")
        return _load_cache_fallback(cache_file, symbol)


def _load_cache_fallback(cache_file: Path, symbol: str) -> Optional[dict]:
    """キャッシュファイルがあればそれを返す。なければ None。"""
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            logger.warning(f"[market_data] フォールバック: キャッシュ使用 {symbol}")
            return cached
        except Exception:
            pass
    logger.warning(f"[market_data] キャッシュなし: {symbol} → マーケットセクション非表示")
    return None


def save_history(data: dict) -> None:
    """
    日次データを CSV に追記蓄積する。
    列: date, open, high, low, close, volume, change, change_percent
    重複日付は上書き。5年超は削除。
    """
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    symbol = data.get("symbol", "unknown")
    safe_name = symbol.replace("^", "_").replace("=", "_")
    csv_path = HISTORY_DIR / f"{safe_name}.csv"

    ohlc = data.get("ohlc", [])
    if not ohlc:
        return

    # 既存データを読み込み
    existing: dict[str, dict] = {}
    if csv_path.exists():
        try:
            lines = csv_path.read_text(encoding="utf-8").strip().splitlines()
            headers = lines[0].split(",") if lines else []
            for line in lines[1:]:
                parts = line.split(",")
                if parts and len(parts) == len(headers):
                    row = dict(zip(headers, parts))
                    existing[row["date"]] = row
        except Exception as e:
            logger.warning(f"[market_data] CSV読み込みエラー: {e}")

    # 最新データをマージ
    change = data.get("change")
    change_pct = data.get("change_percent")
    for row in ohlc:
        d = row["date"]
        existing[d] = {
            "date": d,
            "open": str(row.get("open") or ""),
            "high": str(row.get("high") or ""),
            "low": str(row.get("low") or ""),
            "close": str(row.get("close") or ""),
            "volume": str(row.get("volume") or ""),
            "change": str(change if d == ohlc[-1]["date"] else ""),
            "change_percent": str(change_pct if d == ohlc[-1]["date"] else ""),
        }

    # 日付昇順ソート + 5年超削除
    cutoff = (_jst_now() - timedelta(days=365 * MAX_HISTORY_YEARS)).strftime("%Y-%m-%d")
    rows = sorted(
        [r for r in existing.values() if r["date"] >= cutoff],
        key=lambda x: x["date"],
    )

    # CSV 書き出し
    headers = ["date", "open", "high", "low", "close", "volume", "change", "change_percent"]
    lines = [",".join(headers)]
    for r in rows:
        lines.append(",".join(r.get(h, "") for h in headers))
    csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info(f"[market_data] 履歴保存: {csv_path} ({len(rows)}行)")
