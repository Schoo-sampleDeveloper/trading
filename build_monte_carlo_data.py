#!/usr/bin/env python3
"""
月次リターン系列を計算し data/monte_carlo/{symbol}.json にキャッシュする。
既存の data/historical_daily/nikkei.json (日経225 30年日次データ) を活用。
"""
import json
import math
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
HISTORICAL_DIR = DATA_DIR / "historical_daily"
OUTPUT_DIR = DATA_DIR / "monte_carlo"


def compute_monthly_returns_from_daily(daily_data):
    """日次データから月次リターンを計算（各月の最終取引日終値を使用）"""
    monthly = defaultdict(list)
    for row in daily_data:
        ym = row["date"][:7]
        monthly[ym].append(row["close"])

    sorted_months = sorted(monthly.keys())
    month_closes = [(m, monthly[m][-1]) for m in sorted_months]

    returns = []
    for i in range(1, len(month_closes)):
        prev_close = month_closes[i - 1][1]
        curr_close = month_closes[i][1]
        if prev_close > 0 and curr_close > 0:
            returns.append(
                {"month": month_closes[i][0], "return": curr_close / prev_close - 1}
            )
    return returns


def compute_stats(returns_list):
    """リターン系列の統計量を計算"""
    n = len(returns_list)
    if n == 0:
        return {"mean": 0, "std": 0, "min": 0, "max": 0, "skew": 0, "kurtosis": 0}

    mean = sum(returns_list) / n
    variance = sum((r - mean) ** 2 for r in returns_list) / n
    std = math.sqrt(variance) if variance > 0 else 0

    # skewness & kurtosis
    if std > 0 and n > 2:
        skew = sum(((r - mean) / std) ** 3 for r in returns_list) / n
        kurt = sum(((r - mean) / std) ** 4 for r in returns_list) / n - 3
    else:
        skew = 0
        kurt = 0

    return {
        "mean": round(mean, 8),
        "std": round(std, 8),
        "min": round(min(returns_list), 8),
        "max": round(max(returns_list), 8),
        "skew": round(skew, 4),
        "kurtosis": round(kurt, 4),
        "annualized_mean": round((1 + mean) ** 12 - 1, 6),
        "annualized_vol": round(std * math.sqrt(12), 6),
    }


def build_nikkei():
    """日経225の月次リターンを計算"""
    nikkei_path = HISTORICAL_DIR / "nikkei.json"
    if not nikkei_path.exists():
        print(f"Warning: {nikkei_path} not found")
        return

    with open(nikkei_path) as f:
        daily = json.load(f)

    returns = compute_monthly_returns_from_daily(daily)
    returns_values = [r["return"] for r in returns]

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output = {
        "symbol": "^N225",
        "name": "日経平均株価",
        "currency": "JPY",
        "data_start": returns[0]["month"] if returns else None,
        "data_end": returns[-1]["month"] if returns else None,
        "count": len(returns),
        "monthly_returns": [round(r, 8) for r in returns_values],
        "months": [r["month"] for r in returns],
        "stats": compute_stats(returns_values),
    }

    out_path = OUTPUT_DIR / "_N225.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(
        f"Built _N225.json: {len(returns)} monthly returns "
        f"from {returns[0]['month']} to {returns[-1]['month']}"
    )
    print(f"  Annualized mean: {output['stats']['annualized_mean']:.2%}")
    print(f"  Annualized vol:  {output['stats']['annualized_vol']:.2%}")
    print(f"  Skewness: {output['stats']['skew']:.4f}")
    print(f"  Kurtosis: {output['stats']['kurtosis']:.4f}")


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    build_nikkei()
    print("\nDone.")


if __name__ == "__main__":
    main()
