/**
 * Monte Carlo Simulation WebWorker
 * 10,000+ 試行のモンテカルロ・シミュレーションを非同期実行。
 * 3つのサンプリング・モード: bootstrap / lognormal / garch
 */
'use strict';

// ─── Mulberry32 PRNG (再現性のためシード指定可能) ──────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Box-Muller 変換 (正規乱数生成) ─────────────────────
function boxMuller(rng) {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

// ─── メインシミュレーション ──────────────────────────────
self.onmessage = function (e) {
  const {
    monthlyReturns,
    monthlyAmount,
    numMonths,
    numTrials,
    targetAmount,
    mode,
    seed,
  } = e.data;

  const rng = mulberry32(seed || 42);
  const numReturns = monthlyReturns.length;

  // 統計量 (lognormal / garch モード用)
  let mu = 0,
    sigma = 0;
  if (numReturns > 0) {
    // 対数リターンの平均・標準偏差
    const logReturns = monthlyReturns.map((r) => Math.log(1 + r));
    mu = logReturns.reduce((a, b) => a + b, 0) / numReturns;
    sigma =
      Math.sqrt(
        logReturns.reduce((a, b) => a + (b - mu) ** 2, 0) / numReturns
      ) || 0.01;
  }

  // 全経路の格納 (Float32Array で省メモリ)
  const paths = new Float32Array(numTrials * numMonths);

  const BATCH_SIZE = 500;
  let completed = 0;

  for (let batch = 0; batch < numTrials; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, numTrials);

    for (let trial = batch; trial < batchEnd; trial++) {
      let value = 0;
      let prevVol = sigma; // GARCH用

      for (let month = 0; month < numMonths; month++) {
        // 月初に投資
        value += monthlyAmount;

        let r;
        if (mode === 'bootstrap' || mode === 'historical') {
          // ブートストラップ・サンプリング
          const idx = Math.floor(rng() * numReturns);
          r = monthlyReturns[idx];
        } else if (mode === 'lognormal') {
          // 対数正規サンプリング
          const z = boxMuller(rng);
          r = Math.exp(mu + sigma * z) - 1;
        } else if (mode === 'garch') {
          // 簡易GARCH(1,1)風ボラティリティ・クラスタリング
          const omega = sigma * sigma * 0.05;
          const alpha = 0.1;
          const beta = 0.85;
          const z = boxMuller(rng);
          const vol = Math.sqrt(
            omega + alpha * (prevVol * z) ** 2 + beta * prevVol * prevVol
          );
          r = Math.exp(mu + vol * z) - 1;
          prevVol = vol;
        } else {
          // fallback to bootstrap
          const idx = Math.floor(rng() * numReturns);
          r = monthlyReturns[idx];
        }

        value *= 1 + r;
        if (value < 0) value = 0;

        paths[trial * numMonths + month] = value;
      }
    }

    completed = batchEnd;
    // 進捗報告 (バッチ毎)
    self.postMessage({
      type: 'progress',
      completed,
      total: numTrials,
      pct: Math.round((completed / numTrials) * 100),
    });
  }

  // ─── パーセンタイル集計 ────────────────────────────────
  const percentileKeys = [5, 10, 25, 50, 75, 90, 95];
  const percentiles = {};
  for (const p of percentileKeys) {
    percentiles['p' + p] = new Float64Array(numMonths);
  }
  const principal = new Float64Array(numMonths);

  // 一時ソート用配列
  const column = new Float32Array(numTrials);

  for (let month = 0; month < numMonths; month++) {
    principal[month] = monthlyAmount * (month + 1);

    // 列を抽出
    for (let trial = 0; trial < numTrials; trial++) {
      column[trial] = paths[trial * numMonths + month];
    }

    // ソート
    column.sort();

    // パーセンタイル抽出
    for (const p of percentileKeys) {
      const idx = Math.min(
        Math.floor((numTrials * p) / 100),
        numTrials - 1
      );
      percentiles['p' + p][month] = column[idx];
    }
  }

  // ─── キータイムポイントの分布 ─────────────────────────
  const distributions = {};
  // 5年後, 15年後, 最終
  const keyPoints = [];
  if (numMonths > 60) keyPoints.push({ label: '5y', month: 59 });
  if (numMonths > 180) keyPoints.push({ label: '15y', month: 179 });
  keyPoints.push({ label: 'final', month: numMonths - 1 });

  for (const kp of keyPoints) {
    const m = kp.month;
    if (m >= numMonths) continue;
    const dist = new Float32Array(numTrials);
    for (let trial = 0; trial < numTrials; trial++) {
      dist[trial] = paths[trial * numMonths + m];
    }
    dist.sort();
    distributions[kp.label] = {
      month: m,
      values: Array.from(dist),
    };
  }

  // ─── 統計量計算 ────────────────────────────────────────
  const finalMonth = numMonths - 1;

  // 目標達成確率
  let goalCount = 0;
  for (let trial = 0; trial < numTrials; trial++) {
    if (paths[trial * numMonths + finalMonth] >= targetAmount) {
      goalCount++;
    }
  }

  // 中央値パスの最大ドローダウン
  let maxDD = 0;
  let peak = 0;
  for (let month = 0; month < numMonths; month++) {
    const val = percentiles.p50[month];
    if (val > peak) peak = val;
    if (peak > 0) {
      const dd = (peak - val) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  // 5パーセンタイル経路の最大ドローダウン
  let maxDD5 = 0;
  let peak5 = 0;
  for (let month = 0; month < numMonths; month++) {
    const val = percentiles.p5[month];
    if (val > peak5) peak5 = val;
    if (peak5 > 0) {
      const dd = (peak5 - val) / peak5;
      if (dd > maxDD5) maxDD5 = dd;
    }
  }

  // 年率換算 (中央値)
  const medianFinal = percentiles.p50[finalMonth];
  const totalPrincipal = principal[finalMonth];
  const years = numMonths / 12;

  // IRR近似 (中央値)
  let medianIRR = 0;
  if (medianFinal > 0 && totalPrincipal > 0) {
    // DCA IRR近似: (finalValue / totalPrincipal)^(2/(years+1)) - 1
    medianIRR = Math.pow(medianFinal / totalPrincipal, 2 / (years + 1)) - 1;
  }

  // p5, p95のIRR
  const p5Final = percentiles.p5[finalMonth];
  const p95Final = percentiles.p95[finalMonth];
  let p5IRR = 0,
    p95IRR = 0;
  if (p5Final > 0 && totalPrincipal > 0) {
    p5IRR = Math.pow(p5Final / totalPrincipal, 2 / (years + 1)) - 1;
  }
  if (p95Final > 0 && totalPrincipal > 0) {
    p95IRR = Math.pow(p95Final / totalPrincipal, 2 / (years + 1)) - 1;
  }

  // ─── 結果送信 ─────────────────────────────────────────
  const result = {
    type: 'result',
    percentiles: {},
    principal: Array.from(principal),
    distributions,
    stats: {
      goalProbability: goalCount / numTrials,
      medianFinal,
      p5Final,
      p95Final,
      totalPrincipal,
      maxDrawdown: maxDD,
      maxDrawdown5: maxDD5,
      medianIRR,
      p5IRR,
      p95IRR,
      medianMultiple: totalPrincipal > 0 ? medianFinal / totalPrincipal : 0,
      numTrials,
      numMonths,
      years,
    },
  };

  // Float64Array → Array 変換
  for (const key of Object.keys(percentiles)) {
    result.percentiles[key] = Array.from(percentiles[key]);
  }

  self.postMessage(result);
};
