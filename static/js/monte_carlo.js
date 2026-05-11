/**
 * Monte Carlo Orchestrator
 * WebWorker を管理し、月次リターンデータ取得→シミュレーション実行→UI更新を統括。
 */
'use strict';

const MonteCarloEngine = (function () {
  const WORKER_BASE = 'https://yahoo-proxy.kazuki35344.workers.dev';
  const CACHE_KEY_PREFIX = 'mc_returns_';
  const CACHE_TTL = 7 * 24 * 3600 * 1000; // 7日

  let _worker = null;
  let _currentResolve = null;
  let _currentReject = null;
  let _onProgress = null;

  // ─── Worker 管理 ─────────────────────────────────────
  function getWorker() {
    if (!_worker) {
      const basePath =
        document.querySelector('script[src*="monte_carlo.js"]')?.src
          ?.replace(/monte_carlo\.js.*$/, '') ||
        './static/js/';
      _worker = new Worker(basePath + 'monte_carlo_worker.js');
      _worker.onmessage = function (e) {
        const data = e.data;
        if (data.type === 'progress' && _onProgress) {
          _onProgress(data);
        } else if (data.type === 'result' && _currentResolve) {
          const resolve = _currentResolve;
          _currentResolve = null;
          _currentReject = null;
          resolve(data);
        }
      };
      _worker.onerror = function (err) {
        if (_currentReject) {
          const reject = _currentReject;
          _currentResolve = null;
          _currentReject = null;
          reject(err);
        }
      };
    }
    return _worker;
  }

  // ─── 月次リターンデータ取得 ──────────────────────────
  async function fetchMonthlyReturns(symbol) {
    // 1. LocalStorage キャッシュ確認
    const cacheKey = CACHE_KEY_PREFIX + symbol;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey));
      if (cached && Date.now() - cached.ts < CACHE_TTL && cached.returns?.length > 12) {
        return cached.returns;
      }
    } catch (e) { /* ignore */ }

    // 2. 事前計算済み JSON を試行
    const normalizedSymbol = symbol.replace('^', '_');
    try {
      const basePath = document.querySelector('meta[name="base-url"]')?.content || '.';
      const res = await fetch(
        `${basePath}/data/monte_carlo/${normalizedSymbol}.json`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.monthly_returns?.length > 12) {
          // キャッシュ
          try {
            localStorage.setItem(cacheKey, JSON.stringify({
              ts: Date.now(), returns: data.monthly_returns
            }));
          } catch (e) { /* storage full */ }
          return data.monthly_returns;
        }
      }
    } catch (e) { /* file not found, try API */ }

    // 3. Yahoo Finance API から取得
    const ranges = ['max', '30y', '10y', '5y'];
    for (const range of ranges) {
      try {
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1mo`;
        const proxyUrl = `${WORKER_BASE}/?url=${encodeURIComponent(yahooUrl)}`;
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;

        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result) continue;

        const closes = result.indicators?.quote?.[0]?.close || [];
        const valid = closes.filter((c) => c != null && c > 0);
        if (valid.length < 24) continue;

        // 月次リターン計算
        const returns = [];
        for (let i = 1; i < valid.length; i++) {
          returns.push(valid[i] / valid[i - 1] - 1);
        }

        // キャッシュ
        try {
          localStorage.setItem(cacheKey, JSON.stringify({
            ts: Date.now(), returns
          }));
        } catch (e) { /* storage full */ }

        return returns;
      } catch (e) {
        continue;
      }
    }

    // 4. フォールバック: 合成リターン系列
    return generateSyntheticReturns(symbol);
  }

  function generateSyntheticReturns(symbol) {
    // フォールバック年利からlognormal近似の月次リターンを生成
    const FALLBACK = {
      VOO: 0.10, '^GSPC': 0.10, SPY: 0.10,
      VT: 0.08, QQQ: 0.13, VTI: 0.105,
      '1321.T': 0.05, '1306.T': 0.05, '^N225': 0.05,
      VEA: 0.07, VWO: 0.08,
      BND: 0.03, AGG: 0.03,
      GLD: 0.06, IAU: 0.06,
    };
    const annualReturn = FALLBACK[symbol] ?? 0.07;
    const monthlyMu = Math.log(1 + annualReturn) / 12;
    const monthlySigma = 0.045; // 典型的な月次ボラティリティ

    // Mulberry32 で再現可能な合成系列を生成
    let seed = 0;
    for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) | 0;

    const returns = [];
    for (let i = 0; i < 360; i++) {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const u1 = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const u2 = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
      returns.push(Math.exp(monthlyMu + monthlySigma * z) - 1);
    }
    return returns;
  }

  // ─── シミュレーション実行 ──────────────────────────────
  async function runSimulation(params) {
    const {
      symbol,
      monthlyAmount,
      simYears = 30,
      targetAmount = 100000000,
      numTrials = 10000,
      mode = 'bootstrap',
      seed = 42,
      onProgress,
    } = params;

    _onProgress = onProgress || null;

    // 月次リターン取得
    const monthlyReturns = await fetchMonthlyReturns(symbol);

    if (!monthlyReturns || monthlyReturns.length < 12) {
      throw new Error(`月次リターンデータが不足: ${symbol}`);
    }

    const numMonths = simYears * 12;

    // Worker に送信
    const worker = getWorker();
    return new Promise((resolve, reject) => {
      _currentResolve = resolve;
      _currentReject = reject;

      worker.postMessage({
        monthlyReturns,
        monthlyAmount,
        numMonths,
        numTrials,
        targetAmount,
        mode,
        seed,
      });
    });
  }

  // ─── 任意月の目標達成確率を再計算 ─────────────────────
  function calcGoalProbability(distribution, targetAmount) {
    if (!distribution || !distribution.values) return 0;
    const values = distribution.values;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] >= targetAmount) count++;
    }
    return count / values.length;
  }

  // ─── ユーティリティ ────────────────────────────────────
  function formatJPY(value) {
    if (value >= 1e12) return `¥${(value / 1e12).toFixed(2)}兆`;
    if (value >= 1e8) return `¥${(value / 1e8).toFixed(2)}億`;
    if (value >= 1e4) return `¥${(value / 1e4).toFixed(0)}万`;
    return `¥${Math.round(value).toLocaleString()}`;
  }

  function formatJPYCompact(value) {
    if (value >= 1e12) return `${(value / 1e12).toFixed(1)}兆`;
    if (value >= 1e8) return `${(value / 1e8).toFixed(2)}億`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(0)}万`;
    return Math.round(value).toLocaleString();
  }

  function destroy() {
    if (_worker) {
      _worker.terminate();
      _worker = null;
    }
    _currentResolve = null;
    _currentReject = null;
    _onProgress = null;
  }

  return {
    runSimulation,
    fetchMonthlyReturns,
    calcGoalProbability,
    formatJPY,
    formatJPYCompact,
    destroy,
  };
})();
