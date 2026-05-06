"""
long_term_data.py
過去N年分の月次データを yfinance から取得し、年率統計・ローリングリターン・
ドローダウン曲線を計算する。データは data/long_term/{symbol}.csv にキャッシュ
（30日以上古い場合のみ再取得）。
"""

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

DATA_DIR = Path(__file__).parent / "data" / "long_term"
JST = timezone(timedelta(hours=9))
RISK_FREE_RATE = 0.01  # 年率1%想定

NAME_MAP = {
    "^N225": "日経平均",
    "^GSPC": "S&P 500",
    "^IXIC": "NASDAQ",
    "^DJI": "ダウ平均",
}


def _symbol_to_filename(symbol: str) -> str:
    return symbol.replace("^", "_").replace("=", "_").replace("/", "_")


def _needs_refresh(csv_path: Path) -> bool:
    """キャッシュが存在しない、または30日以上古い場合は True。"""
    if not csv_path.exists():
        return True
    mtime = datetime.fromtimestamp(csv_path.stat().st_mtime, tz=JST)
    return (datetime.now(JST) - mtime).days >= 30


def _fetch_raw(symbol: str, start: str) -> pd.Series:
    """yfinance で月末終値の Series を取得。"""
    tk = yf.Ticker(symbol)
    df = tk.history(start=start, auto_adjust=True)
    if df.empty:
        return pd.Series(dtype=float)
    df.index = pd.to_datetime(df.index)
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    # 月末にリサンプリング
    monthly = df["Close"].resample("ME").last().dropna()
    return monthly


def _compute_stats(yearly_returns_decimal: pd.Series) -> dict:
    """年率統計を計算。yearly_returns_decimal は小数表記（0.10 = 10%）。"""
    r = yearly_returns_decimal.dropna()
    if len(r) < 2:
        return {}

    annual_return_avg = r.mean() * 100
    annual_return_median = r.median() * 100
    volatility = r.std(ddof=1) * 100

    excess = r - RISK_FREE_RATE
    std = r.std(ddof=1)
    sharpe = float(excess.mean() / std) if std > 0 else 0.0

    cumulative = (1 + r).cumprod()
    rolling_max = cumulative.cummax()
    drawdown = (cumulative - rolling_max) / rolling_max
    max_dd = float(drawdown.min()) * 100

    positive_years_pct = float((r > 0).sum()) / len(r) * 100

    return {
        "annual_return_avg": round(annual_return_avg, 2),
        "annual_return_median": round(annual_return_median, 2),
        "volatility": round(volatility, 2),
        "sharpe_ratio": round(sharpe, 2),
        "max_drawdown_all_time": round(max_dd, 2),
        "positive_years_pct": round(positive_years_pct, 1),
    }


def _compute_rolling_returns(yearly_returns_decimal: list, windows: list) -> dict:
    """N年保有時の年率リターン分布リストを計算。"""
    result = {}
    vals = [r for r in yearly_returns_decimal if r is not None]
    for w in windows:
        rolls = []
        for i in range(len(vals) - w + 1):
            segment = vals[i : i + w]
            cum = 1.0
            for r in segment:
                cum *= 1 + r
            ann_return = round((cum ** (1.0 / w) - 1) * 100, 2)
            rolls.append(ann_return)
        result[f"{w}y"] = rolls
    return result


def _compute_drawdown_curve(monthly_close: pd.Series) -> list:
    """月次ドローダウン曲線（アンダーウォーター）を計算。"""
    rolling_max = monthly_close.cummax()
    dd = (monthly_close - rolling_max) / rolling_max * 100
    result = []
    for date, val in dd.items():
        result.append({
            "date": date.strftime("%Y-%m"),
            "drawdown": round(float(val), 2),
        })
    return result


def fetch_long_term_data(symbol: str, years: int = 30) -> dict:
    """
    過去N年分の月次データを取得・計算して返す。

    Returns:
        {
            "symbol": str,
            "name": str,
            "monthly": [{"date": "YYYY-MM", "close": float, "return_pct": float|None}, ...],
            "yearly": [{"year": int, "open": float, "close": float,
                        "return_pct": float|None, "max_drawdown": float}, ...],
            "stats": { ... },
            "rolling_returns": {"10y": [...], "20y": [...]},
            "drawdown_curve": [{"date": "YYYY-MM", "drawdown": float}, ...],
            "updated_at": str,
        }
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = _symbol_to_filename(symbol)
    csv_path = DATA_DIR / f"{safe_name}.csv"

    start_year = datetime.now().year - years
    start_date = f"{start_year}-01-01"

    # ── キャッシュ取得 or 新規フェッチ ──
    if _needs_refresh(csv_path):
        print(f"  [long_term] {symbol} データ取得中 ({start_date}〜)...")
        monthly_series = _fetch_raw(symbol, start=start_date)
        if monthly_series.empty:
            print(f"  [WARN] {symbol} の長期データ取得に失敗しました。")
            return {}
        monthly_series.to_csv(csv_path, header=["close"])
        print(f"  [long_term] キャッシュ保存: {csv_path}")
    else:
        monthly_df = pd.read_csv(csv_path, index_col=0, parse_dates=True)
        monthly_series = monthly_df["close"].dropna()
        print(f"  [long_term] {symbol} キャッシュ読み込み: {csv_path}")

    if monthly_series.empty:
        return {}

    # ── 月次リスト ──
    monthly_list = []
    prev_close = None
    for date, close_val in monthly_series.items():
        if pd.isna(close_val):
            continue
        ret = ((close_val - prev_close) / prev_close * 100) if prev_close else None
        monthly_list.append({
            "date": date.strftime("%Y-%m"),
            "close": round(float(close_val), 2),
            "return_pct": round(float(ret), 2) if ret is not None else None,
        })
        prev_close = float(close_val)

    # ── 年次集計 ──
    monthly_df_work = monthly_series.to_frame(name="close")
    monthly_df_work["year"] = monthly_df_work.index.year
    yearly_list = []
    prev_year_close = None

    for year, group in monthly_df_work.groupby("year")["close"]:
        group = group.dropna()
        if group.empty:
            continue
        open_val = float(group.iloc[0])
        close_val = float(group.iloc[-1])
        ret = ((close_val - prev_year_close) / prev_year_close * 100) if prev_year_close else None

        # 年中の最大ドローダウン
        if len(group) > 1:
            roll_max = group.cummax()
            dd = (group - roll_max) / roll_max * 100
            max_dd_yr = round(float(dd.min()), 2)
        else:
            max_dd_yr = 0.0

        yearly_list.append({
            "year": int(year),
            "open": round(open_val, 2),
            "close": round(close_val, 2),
            "return_pct": round(float(ret), 2) if ret is not None else None,
            "max_drawdown": max_dd_yr,
        })
        prev_year_close = close_val

    # ── 統計計算 ──
    yearly_returns_decimal = pd.Series(
        [r["return_pct"] / 100 for r in yearly_list if r["return_pct"] is not None]
    )
    stats = _compute_stats(yearly_returns_decimal)

    # ── ローリングリターン ──
    returns_list = [r["return_pct"] / 100 for r in yearly_list if r["return_pct"] is not None]
    rolling_returns = _compute_rolling_returns(returns_list, windows=[10, 20])

    # ── ドローダウン曲線 ──
    drawdown_curve = _compute_drawdown_curve(monthly_series)

    return {
        "symbol": symbol,
        "name": NAME_MAP.get(symbol, symbol),
        "monthly": monthly_list,
        "yearly": yearly_list,
        "stats": stats,
        "rolling_returns": rolling_returns,
        "drawdown_curve": drawdown_curve,
        "updated_at": datetime.now(JST).strftime("%Y-%m-%d %H:%M JST"),
    }
