/**
 * portfolio.js
 * ポートフォリオ管理 — LocalStorage + Yahoo Finance (Cloudflare Worker経由)
 */

'use strict';

// ─── 定数 ─────────────────────────────────────────────────
const WORKER_BASE = 'https://yahoo-proxy.kazuki35344.workers.dev';
const STORAGE_KEY = 'portfolio_v1';
const STORAGE_KEY_RECURRING = 'portfolio_recurring_v1';

// ─── ストレージ ───────────────────────────────────────────
function loadPortfolio() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function savePortfolio(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function loadRecurring() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RECURRING) || '[]');
  } catch (e) {
    return [];
  }
}

function saveRecurring(items) {
  localStorage.setItem(STORAGE_KEY_RECURRING, JSON.stringify(items));
}

// ─── 通貨フォーマット ─────────────────────────────────────
function fmt(n, currency) {
  if (n == null || isNaN(n)) return '—';
  const cur = currency || 'JPY';
  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: cur === 'JPY' ? 0 : 2,
    }).format(n);
  } catch (e) {
    return (cur === 'JPY' ? '¥' : '$') + n.toLocaleString();
  }
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function fmtNum(n, decimals = 0) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('ja-JP', { maximumFractionDigits: decimals });
}

// ─── 数字カウントアップアニメーション ────────────────────
function animateNumber(el, from, to, duration = 600, formatter) {
  if (!el) return;
  const fmt_ = formatter || (v => Math.round(v).toLocaleString('ja-JP'));
  const start = performance.now();
  function step(t) {
    const p = Math.min((t - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt_(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─── Yahoo Finance API（Cloudflare Worker経由） ──────────
let _quoteCache = {};
let _quoteCacheTime = 0;
const CACHE_TTL = 25000; // 25秒

// 1銘柄の現在値取得（v8/chart エンドポイント使用）
async function fetchQuoteSingle(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const proxyUrl = `${WORKER_BASE}/?url=${encodeURIComponent(yahooUrl)}`;

  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('No data');

    const meta = result.meta;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
    return {
      symbol: meta.symbol,
      price: meta.regularMarketPrice,
      prevClose,
      change: meta.regularMarketPrice - prevClose,
      changePct: ((meta.regularMarketPrice / prevClose) - 1) * 100,
      currency: meta.currency,
      name: meta.longName || meta.shortName || meta.symbol,
      exchange: meta.fullExchangeName,
      marketState: meta.marketState || 'UNKNOWN',
    };
  } catch (e) {
    console.warn(`fetchQuoteSingle(${symbol}) failed:`, e);
    return null;
  }
}

// 複数銘柄を並列取得
async function fetchQuotes(symbols) {
  if (!symbols.length) return {};
  const now = Date.now();
  if (now - _quoteCacheTime < CACHE_TTL) return _quoteCache;

  const results = await Promise.all(symbols.map(s => fetchQuoteSingle(s)));
  const map = {};
  let anySuccess = false;
  results.forEach((q, i) => {
    if (q) {
      map[symbols[i]] = q;
      anySuccess = true;
    }
  });

  if (anySuccess) {
    _quoteCache = map;
    _quoteCacheTime = now;
    showApiError(false);
  } else {
    showApiError(true);
  }
  return _quoteCache;
}

async function fetchHistory(symbol, range = '1mo', interval = '1d') {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const proxyUrl = `${WORKER_BASE}/?url=${encodeURIComponent(yahooUrl)}`;

  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    return ts.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter(d => d.c != null);
  } catch (e) {
    console.warn(`fetchHistory(${symbol}) failed:`, e);
    return null;
  }
}

function showApiError(show) {
  const el = document.getElementById('pfApiError');
  if (el) el.hidden = !show;
}

// ─── ティッカー正規化・バリデーション ────────────────────
// 4桁数字なら .T を付与
function normalizeSymbol(input) {
  const s = input.trim().toUpperCase();
  if (/^\d{4}$/.test(s)) return s + '.T';
  return s;
}

// バリデーション: 価格取得を試みる、失敗しても候補を提示
async function validateSymbol(input) {
  const normalized = normalizeSymbol(input);
  const candidates = [normalized];

  // 4桁数字の場合は .T だけでなく素のシンボルも試す
  const raw = input.trim().toUpperCase();
  if (/^\d{4}$/.test(raw) && normalized !== raw) {
    candidates.push(raw);
  }

  for (const cand of candidates) {
    const quote = await fetchQuoteSingle(cand);
    if (quote && quote.price) {
      return { ok: true, symbol: cand, quote };
    }
  }

  return { ok: false, tried: candidates, symbol: normalized };
}

// ─── 損益計算 ─────────────────────────────────────────────
function calcPnL(item, quote) {
  const market = item.qty * (quote.price || 0);
  const cost = item.qty * (item.avgCost || 0);
  const pnl = market - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const dayChange = item.qty * (quote.change || 0);
  const dayChangePct = quote.changePct || 0;
  return { market, cost, pnl, pnlPct, dayChange, dayChangePct };
}

// ─── ドーナツチャート ─────────────────────────────────────
let _donutChart = null;
const DONUT_COLORS = [
  '#00c853', '#2196f3', '#ff9800', '#e91e63', '#9c27b0',
  '#00bcd4', '#8bc34a', '#ff5722', '#607d8b', '#ffc107',
];

function renderDonut(items, quotes, mode = 'symbol') {
  const canvas = document.getElementById('pfDonut');
  if (!canvas) return;

  let labels = [];
  let data = [];
  let colors = [];

  if (mode === 'symbol') {
    items.forEach((item, i) => {
      const q = quotes[item.symbol] || {};
      const val = item.qty * (q.price || item.avgCost || 0);
      labels.push(item.symbol);
      data.push(val);
      colors.push(DONUT_COLORS[i % DONUT_COLORS.length]);
    });
  } else {
    const sectorMap = {};
    items.forEach(item => {
      const q = quotes[item.symbol] || {};
      const sector = q.sector || 'Unknown';
      const val = item.qty * (q.price || item.avgCost || 0);
      sectorMap[sector] = (sectorMap[sector] || 0) + val;
    });
    Object.entries(sectorMap).forEach(([sec, val], i) => {
      labels.push(sec);
      data.push(val);
      colors.push(DONUT_COLORS[i % DONUT_COLORS.length]);
    });
  }

  if (_donutChart) {
    _donutChart.data.labels = labels;
    _donutChart.data.datasets[0].data = data;
    _donutChart.data.datasets[0].backgroundColor = colors;
    _donutChart.update('none');
    return;
  }

  const ctx = canvas.getContext('2d');
  _donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth: 2,
        borderColor: '#11161d',
        hoverBorderColor: '#1a2029',
      }],
    },
    options: {
      cutout: '70%',
      responsive: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? (ctx.parsed / total * 100).toFixed(1) : 0;
              return ` ${ctx.label}: ${pct}%`;
            },
          },
          backgroundColor: '#1a2029',
          titleColor: '#e8edf2',
          bodyColor: '#8b95a3',
          borderColor: '#2a3340',
          borderWidth: 1,
        },
      },
      animation: { duration: 600 },
    },
  });
}

// ─── スパークライン（ミニチャート） ──────────────────────
function renderSparkline(containerId, data, color = '#00c853') {
  const container = document.getElementById(containerId);
  if (!container || !data || data.length < 2) return;
  container.innerHTML = '';

  const W = container.offsetWidth || 300;
  const H = container.offsetHeight || 56;
  const prices = data.map(d => d.c).filter(v => v != null);
  if (!prices.length) return;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * W;
    const y = H - ((p - min) / range) * H * 0.85 - H * 0.075;
    return `${x},${y}`;
  });

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.id = `spark-grad-${containerId}`;
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', color);
  stop1.setAttribute('stop-opacity', '0.3');
  const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', color);
  stop2.setAttribute('stop-opacity', '0');
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const lastX = (prices.length - 1) / (prices.length - 1) * W;
  const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  fillPath.setAttribute('d', `M${pts.join('L')} L${lastX},${H} L0,${H} Z`);
  fillPath.setAttribute('fill', `url(#spark-grad-${containerId})`);
  svg.appendChild(fillPath);

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', pts.join(' '));
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', color);
  polyline.setAttribute('stroke-width', '1.5');
  polyline.setAttribute('stroke-linejoin', 'round');
  polyline.setAttribute('stroke-linecap', 'round');
  svg.appendChild(polyline);

  container.appendChild(svg);
}

// ─── メインレンダリング ───────────────────────────────────
let _prevTotal = 0;
let _donutMode = 'symbol';
let _sortMode = 'value';
let _refreshTimer = null;
let _currentMode = 'holdings'; // 'holdings' or 'recurring'

async function render() {
  if (_currentMode === 'recurring') {
    await renderRecurring();
    return;
  }

  const items = loadPortfolio();
  const pfEmpty = document.getElementById('pfEmpty');
  const pfList = document.getElementById('pfList');
  const pfHoldingCount = document.getElementById('pfHoldingCount');

  if (!items.length) {
    if (pfEmpty) pfEmpty.hidden = false;
    if (pfList) pfList.innerHTML = '';
    const tv = document.getElementById('pfTotalValue');
    if (tv) tv.textContent = '¥ 0';
    const td = document.getElementById('pfTotalDelta');
    if (td) td.className = 'pf-hero__delta';
    const da = document.querySelector('.pf-delta-amount');
    if (da) da.textContent = '+¥ 0';
    const dp = document.querySelector('.pf-delta-pct');
    if (dp) dp.textContent = '(+0.00%)';
    if (pfHoldingCount) pfHoldingCount.textContent = '0';
    return;
  }

  if (pfEmpty) pfEmpty.hidden = true;

  const quotes = await fetchQuotes(items.map(i => i.symbol));

  // ─── ヒーロー集計 ───
  let totalValue = 0;
  let totalCost = 0;
  let totalDayChange = 0;

  items.forEach(item => {
    const q = quotes[item.symbol];
    if (!q) return;
    const { market, cost, dayChange } = calcPnL(item, q);
    totalValue += market;
    totalCost += cost;
    totalDayChange += dayChange;
  });

  const totalPnL = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  // 総評価額（アニメーション）
  const heroVal = document.getElementById('pfTotalValue');
  if (heroVal) {
    animateNumber(heroVal, _prevTotal, totalValue, 800, v => {
      const c = Object.values(quotes)[0]?.currency || 'JPY';
      return fmt(v, c);
    });
  }
  _prevTotal = totalValue;

  const heroD = document.getElementById('pfTotalDelta');
  const deltaAmt = document.querySelector('.pf-delta-amount');
  const deltaPct = document.querySelector('.pf-delta-pct');
  const currency = Object.values(quotes)[0]?.currency || 'JPY';

  if (heroD) {
    heroD.className = 'pf-hero__delta ' + (totalPnL >= 0 ? 'up' : 'down');
  }
  const arrow = document.querySelector('.pf-arrow');
  if (arrow) arrow.textContent = totalPnL >= 0 ? '▲' : '▼';
  if (deltaAmt) deltaAmt.textContent = (totalPnL >= 0 ? '+' : '') + fmt(totalPnL, currency);
  if (deltaPct) deltaPct.textContent = `(${fmtPct(totalPnLPct)})`;

  if (pfHoldingCount) pfHoldingCount.textContent = items.length;

  renderDonut(items, quotes, _donutMode);
  renderHoldingsList(items, quotes);
}

function renderHoldingsList(items, quotes) {
  const pfList = document.getElementById('pfList');
  if (!pfList) return;

  const template = document.getElementById('pfRowTemplate');
  if (!template) return;

  const currency = Object.values(quotes)[0]?.currency || 'JPY';

  // ソート
  const sorted = [...items].sort((a, b) => {
    const qa = quotes[a.symbol] || {};
    const qb = quotes[b.symbol] || {};
    if (_sortMode === 'value') {
      return (b.qty * (qb.price || 0)) - (a.qty * (qa.price || 0));
    }
    if (_sortMode === 'pnl_pct') {
      const pa = calcPnL(a, qa).pnlPct;
      const pb = calcPnL(b, qb).pnlPct;
      return pb - pa;
    }
    return a.symbol.localeCompare(b.symbol);
  });

  // 既存の展開状態を保持
  const expandedSet = new Set();
  pfList.querySelectorAll('.pf-row[data-symbol]').forEach(row => {
    const exp = row.querySelector('.pf-row__expand');
    if (exp && !exp.hidden) expandedSet.add(row.dataset.symbol);
  });

  pfList.innerHTML = '';

  sorted.forEach((item, idx) => {
    const q = quotes[item.symbol] || {};
    const { market, pnl, pnlPct, dayChange, dayChangePct } = calcPnL(item, q);
    const cur = q.currency || currency;

    const clone = template.content.cloneNode(true);
    const li = clone.querySelector('.pf-row');

    li.dataset.symbol = item.symbol;
    li.style.setProperty('--i', idx);

    li.querySelector('.pf-row__symbol').textContent = item.symbol;
    li.querySelector('.pf-row__name').textContent = q.name || item.name || '';
    li.querySelector('.pf-row__value').textContent = fmt(market, cur);
    li.querySelector('.pf-row__qty').textContent = fmtNum(item.qty, 4) + ' 株';

    const pnlEl = li.querySelector('.pf-row__pnl-pct');
    pnlEl.textContent = fmtPct(pnlPct);
    pnlEl.className = 'pf-row__pnl-pct ' + (pnlPct >= 0 ? 'up' : 'down');

    const dayEl = li.querySelector('.pf-row__day-change');
    const daySign = dayChange >= 0 ? '+' : '';
    dayEl.textContent = `${daySign}${fmt(dayChange, cur)} 今日`;
    dayEl.style.color = dayChange >= 0 ? 'var(--bullish)' : 'var(--bearish)';

    // 展開パネル
    const expand = li.querySelector('.pf-row__expand');
    li.querySelector('.pf-d-qty').textContent = fmtNum(item.qty, 4);
    li.querySelector('.pf-d-avg').textContent = fmt(item.avgCost, cur);
    li.querySelector('.pf-d-last').textContent = q.price != null ? fmt(q.price, cur) : '—';
    li.querySelector('.pf-d-day').textContent = `${daySign}${fmtPct(dayChangePct)}`;
    li.querySelector('.pf-d-day').style.color = dayChange >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    li.querySelector('.pf-d-pnl').textContent = (pnl >= 0 ? '+' : '') + fmt(pnl, cur);
    li.querySelector('.pf-d-pnl').style.color = pnl >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    li.querySelector('.pf-d-pnlpct').textContent = fmtPct(pnlPct);
    li.querySelector('.pf-d-pnlpct').style.color = pnlPct >= 0 ? 'var(--bullish)' : 'var(--bearish)';

    // 展開状態の復元
    if (expandedSet.has(item.symbol)) {
      expand.hidden = false;
    }

    // メインボタン: 展開トグル
    li.querySelector('.pf-row__main').addEventListener('click', () => {
      const isHidden = expand.hidden;
      expand.hidden = !isHidden;
      if (!isHidden) return;
      // ミニチャートを遅延ロード
      const chartDiv = expand.querySelector('.pf-row__chart');
      if (chartDiv && !chartDiv.dataset.loaded) {
        chartDiv.dataset.loaded = '1';
        const chartId = `chart-${item.symbol.replace(/[^a-z0-9]/gi, '')}`;
        chartDiv.innerHTML = `<div id="${chartId}" style="height:80px;"></div>`;
        fetchHistory(item.symbol, '1mo', '1d').then(hist => {
          if (!hist) return;
          const color = pnlPct >= 0 ? '#00c853' : '#ff3b30';
          renderSparkline(chartId, hist, color);
        });
      }
    });

    // 編集ボタン
    li.querySelector('.pf-edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(item);
    });

    // 削除ボタン
    li.querySelector('.pf-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteHolding(item.symbol);
    });

    pfList.appendChild(clone);
  });
}

// ─── 削除 ────────────────────────────────────────────────
function deleteHolding(symbol) {
  const items = loadPortfolio().filter(i => i.symbol !== symbol);
  savePortfolio(items);
  _quoteCache = {};
  _quoteCacheTime = 0;
  render();
}

function deleteRecurring(symbol) {
  const items = loadRecurring().filter(i => i.symbol !== symbol);
  saveRecurring(items);
  renderRecurring();
}

// ─── 積立計算ロジック ─────────────────────────────────────
async function computeRecurring(item) {
  const start = new Date(item.startMonth + '-01');
  const now = new Date();
  const monthsElapsed =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth()) + 1;

  const range = monthsElapsed > 60 ? '10y' : '5y';
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=${range}&interval=1mo`;
  const proxyUrl = `${WORKER_BASE}/?url=${encodeURIComponent(yahooUrl)}`;

  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const opens = result.indicators?.quote?.[0]?.open || [];
    const currentPrice = result.meta.regularMarketPrice;
    const currency = result.meta.currency || 'USD';

    let totalShares = 0;
    let totalInvested = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const date = new Date(timestamps[i] * 1000);
      if (date < start) continue;
      if (date > now) break;

      const price = opens[i];
      if (!price) continue;

      const shares = item.monthlyAmount / price;
      totalShares += shares;
      totalInvested += item.monthlyAmount;
    }

    const currentValue = totalShares * currentPrice;
    const pnl = currentValue - totalInvested;
    const pnlPct = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;

    // 年率換算 (CAGR)
    const years = monthsElapsed / 12;
    const cagr =
      totalInvested > 0 && years > 0
        ? (Math.pow(currentValue / totalInvested, 1 / years) - 1) * 100
        : 0;

    return {
      totalShares,
      totalInvested,
      currentValue,
      currentPrice,
      pnl,
      pnlPct,
      monthsElapsed,
      cagr,
      currency,
    };
  } catch (e) {
    console.warn(`computeRecurring(${item.symbol}) failed:`, e);
    return null;
  }
}

// ─── Recurring レンダリング ──────────────────────────────
async function renderRecurring() {
  const items = loadRecurring();
  const pfRecList = document.getElementById('pfRecList');
  const pfRecEmpty = document.getElementById('pfRecEmpty');

  if (!items.length) {
    if (pfRecEmpty) pfRecEmpty.hidden = false;
    if (pfRecList) pfRecList.innerHTML = '';
    const inv = document.getElementById('pfRecInvested');
    const cur = document.getElementById('pfRecCurrent');
    const pnl = document.getElementById('pfRecPnL');
    if (inv) inv.textContent = '¥ 0';
    if (cur) cur.textContent = '¥ 0';
    if (pnl) pnl.textContent = '¥ 0 (+0.00%)';
    return;
  }

  if (pfRecEmpty) pfRecEmpty.hidden = true;
  if (pfRecList) pfRecList.innerHTML =
    '<li style="padding:16px;color:var(--text-muted);text-align:center;font-size:13px;">計算中...</li>';

  const results = await Promise.all(items.map(item => computeRecurring(item)));

  let totalInvested = 0;
  let totalCurrent = 0;
  results.forEach(r => {
    if (r) {
      totalInvested += r.totalInvested;
      totalCurrent += r.currentValue;
    }
  });

  const totalPnL = totalCurrent - totalInvested;
  const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

  const invEl = document.getElementById('pfRecInvested');
  const curEl = document.getElementById('pfRecCurrent');
  const pnlEl = document.getElementById('pfRecPnL');
  if (invEl) invEl.textContent = fmt(totalInvested, 'JPY');
  if (curEl) curEl.textContent = fmt(totalCurrent, 'JPY');
  if (pnlEl) {
    pnlEl.textContent = `${totalPnL >= 0 ? '+' : ''}${fmt(totalPnL, 'JPY')} (${fmtPct(totalPnLPct)})`;
    pnlEl.style.color = totalPnL >= 0 ? 'var(--bullish)' : 'var(--bearish)';
  }

  if (!pfRecList) return;
  pfRecList.innerHTML = '';

  items.forEach((item, idx) => {
    const r = results[idx];
    const pnlColor = r && r.pnl >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    const pnlSign = r && r.pnl >= 0 ? '+' : '';
    const avgCost = r && r.totalShares > 0 ? r.totalInvested / r.totalShares : null;

    const li = document.createElement('li');
    li.className = 'pf-row';
    li.style.setProperty('--i', idx);
    li.dataset.symbol = item.symbol;

    li.innerHTML = `
      <button class="pf-row__main" type="button">
        <div class="pf-row__left">
          <div class="pf-row__symbol">${item.symbol}</div>
          <div class="pf-row__name">月${fmt(item.monthlyAmount, 'JPY')} × ${r ? r.monthsElapsed : '?'}ヶ月</div>
        </div>
        <div class="pf-row__center">
          <div class="pf-row__value">${r ? fmt(r.currentValue, r.currency) : '—'}</div>
          <div class="pf-row__qty">投入: ${r ? fmt(r.totalInvested, 'JPY') : '—'}</div>
        </div>
        <div class="pf-row__right">
          <div class="pf-row__pnl-pct ${r && r.pnl >= 0 ? 'up' : 'down'}">${r ? fmtPct(r.pnlPct) : '—'}</div>
          <div class="pf-row__day-change" style="color:${pnlColor}">${r ? pnlSign + fmt(r.pnl, r.currency) : '—'}</div>
        </div>
      </button>
      <div class="pf-row__expand" hidden>
        <div class="pf-row__grid">
          <div><span>累計投入</span><b>${r ? fmt(r.totalInvested, 'JPY') : '—'}</b></div>
          <div><span>現在評価額</span><b>${r ? fmt(r.currentValue, r.currency) : '—'}</b></div>
          <div><span>累計株数</span><b>${r ? fmtNum(r.totalShares, 4) : '—'}</b></div>
          <div><span>平均取得単価</span><b>${r && avgCost ? fmt(avgCost, r.currency) : '—'}</b></div>
          <div><span>現在価格</span><b>${r ? fmt(r.currentPrice, r.currency) : '—'}</b></div>
          <div><span>損益</span><b style="color:${pnlColor}">${r ? pnlSign + fmt(r.pnl, r.currency) : '—'}</b></div>
          <div><span>月数</span><b>${r ? r.monthsElapsed + 'ヶ月' : '—'}</b></div>
          <div><span>年率換算</span><b style="color:${r && r.cagr >= 0 ? 'var(--bullish)' : 'var(--bearish)'}">${r ? fmtPct(r.cagr) : '—'}</b></div>
          <div><span>開始月</span><b>${item.startMonth}</b></div>
        </div>
        <div class="pf-row__actions">
          <button class="pf-btn-ghost pf-rec-edit" type="button">✏ 編集</button>
          <button class="pf-btn-danger pf-rec-delete" type="button">🗑 削除</button>
        </div>
      </div>
    `;

    li.querySelector('.pf-row__main').addEventListener('click', () => {
      const expand = li.querySelector('.pf-row__expand');
      expand.hidden = !expand.hidden;
    });

    li.querySelector('.pf-rec-edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditRecurringModal(item);
    });

    li.querySelector('.pf-rec-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteRecurring(item.symbol);
    });

    pfRecList.appendChild(li);
  });
}

// ─── FAB & モーダル ──────────────────────────────────────
function openModal(edit = null, mode = null) {
  const modal = document.getElementById('pfModal');
  if (!modal) return;
  modal.hidden = false;

  const formMode = mode || (edit?.monthlyAmount != null ? 'recurring' : 'holdings');

  // フォームモード切替
  document.querySelectorAll('input[name="pfFormMode"]').forEach(radio => {
    radio.checked = radio.value === formMode;
  });
  toggleFormMode(formMode);

  if (formMode === 'recurring') {
    document.getElementById('pfTickerInput').value = edit?.symbol || '';
    document.getElementById('pfRecAmount').value = edit?.monthlyAmount || '';
    document.getElementById('pfRecStart').value = edit?.startMonth || '';
    modal.dataset.editingRecurring = edit?.symbol || '';
    modal.dataset.editing = '';
  } else {
    document.getElementById('pfTickerInput').value = edit?.symbol || '';
    document.getElementById('pfQtyInput').value = edit?.qty || '';
    document.getElementById('pfAvgInput').value = edit?.avgCost || '';
    modal.dataset.editing = edit?.symbol || '';
    modal.dataset.editingRecurring = '';
  }

  document.getElementById('pfSuggest').innerHTML = '';
  document.getElementById('pfTickerInput').focus();

  const title = document.querySelector('.pf-modal__title');
  if (title) title.textContent = edit ? '銘柄を編集' : '銘柄を追加';
}

function openEditModal(item) {
  openModal(item, 'holdings');
}

function openEditRecurringModal(item) {
  openModal(item, 'recurring');
}

function toggleFormMode(mode) {
  const holdingsFields = document.getElementById('pfHoldingsFields');
  const recurringFields = document.getElementById('pfRecurringFields');
  if (holdingsFields) holdingsFields.hidden = mode !== 'holdings';
  if (recurringFields) recurringFields.hidden = mode !== 'recurring';
}

function closeModal() {
  const modal = document.getElementById('pfModal');
  if (modal) {
    modal.hidden = true;
    document.getElementById('pfSuggest').innerHTML = '';
  }
}

async function saveHolding() {
  const formModeEl = document.querySelector('input[name="pfFormMode"]:checked');
  const formMode = formModeEl?.value || 'holdings';

  if (formMode === 'recurring') {
    await saveRecurringItem();
    return;
  }

  const modal = document.getElementById('pfModal');
  const ticker = document.getElementById('pfTickerInput').value.trim();
  const qty = parseFloat(document.getElementById('pfQtyInput').value);
  const avgCost = parseFloat(document.getElementById('pfAvgInput').value);

  if (!ticker) { alert('ティッカーを入力してください'); return; }
  if (!qty || qty <= 0) { alert('数量を正しく入力してください'); return; }
  if (!avgCost || avgCost <= 0) { alert('平均取得単価を正しく入力してください'); return; }

  const saveBtn = document.getElementById('pfSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '確認中…';

  // シンボルバリデーション
  const validation = await validateSymbol(ticker);
  let finalSymbol = validation.symbol;
  let finalName = validation.quote?.name || finalSymbol;

  if (!validation.ok) {
    const proceed = confirm(
      `「${validation.tried.join('」「')}」の価格データが取得できませんでした。それでも登録しますか？`
    );
    if (!proceed) {
      saveBtn.disabled = false;
      saveBtn.textContent = '追加';
      return;
    }
    finalName = finalSymbol;
  }

  const items = loadPortfolio();
  const editingSymbol = modal.dataset.editing;
  const existing = items.findIndex(i => i.symbol === finalSymbol);

  const newItem = {
    symbol: finalSymbol,
    qty,
    avgCost,
    name: finalName,
    addedAt: new Date().toISOString(),
  };

  if (editingSymbol && editingSymbol !== finalSymbol) {
    const oldIdx = items.findIndex(i => i.symbol === editingSymbol);
    if (oldIdx >= 0) items.splice(oldIdx, 1);
  }

  if (existing >= 0 && editingSymbol === finalSymbol) {
    items[existing] = newItem;
  } else if (existing >= 0) {
    if (!confirm(`${finalSymbol} は既に登録されています。上書きしますか？`)) {
      saveBtn.disabled = false;
      saveBtn.textContent = '追加';
      return;
    }
    items[existing] = newItem;
  } else {
    items.push(newItem);
  }

  savePortfolio(items);
  _quoteCache = {};
  _quoteCacheTime = 0;
  closeModal();
  saveBtn.disabled = false;
  saveBtn.textContent = '追加';
  render();
}

async function saveRecurringItem() {
  const modal = document.getElementById('pfModal');
  const ticker = document.getElementById('pfTickerInput').value.trim();
  const monthlyAmount = parseFloat(document.getElementById('pfRecAmount').value);
  const startMonth = document.getElementById('pfRecStart').value;

  if (!ticker) { alert('ティッカーを入力してください'); return; }
  if (!monthlyAmount || monthlyAmount <= 0) { alert('積立金額を正しく入力してください'); return; }
  if (!startMonth) { alert('開始月を入力してください'); return; }

  const saveBtn = document.getElementById('pfSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '確認中…';

  const validation = await validateSymbol(ticker);
  let finalSymbol = validation.symbol;

  if (!validation.ok) {
    const proceed = confirm(
      `「${validation.tried.join('」「')}」の価格データが取得できませんでした。それでも登録しますか？`
    );
    if (!proceed) {
      saveBtn.disabled = false;
      saveBtn.textContent = '追加';
      return;
    }
  }

  const items = loadRecurring();
  const editingSymbol = modal.dataset.editingRecurring;
  const existing = items.findIndex(i => i.symbol === finalSymbol);

  const newItem = {
    symbol: finalSymbol,
    monthlyAmount,
    startMonth,
    addedAt: new Date().toISOString(),
  };

  if (editingSymbol && editingSymbol !== finalSymbol) {
    const oldIdx = items.findIndex(i => i.symbol === editingSymbol);
    if (oldIdx >= 0) items.splice(oldIdx, 1);
  }

  if (existing >= 0 && editingSymbol === finalSymbol) {
    items[existing] = newItem;
  } else if (existing >= 0) {
    if (!confirm(`${finalSymbol} は既に登録されています。上書きしますか？`)) {
      saveBtn.disabled = false;
      saveBtn.textContent = '追加';
      return;
    }
    items[existing] = newItem;
  } else {
    items.push(newItem);
  }

  saveRecurring(items);
  closeModal();
  saveBtn.disabled = false;
  saveBtn.textContent = '追加';
  renderRecurring();
}

// ─── ティッカーサジェスト ────────────────────────────────
let _suggestTimer = null;

async function onTickerInput() {
  clearTimeout(_suggestTimer);
  const val = document.getElementById('pfTickerInput').value.trim();
  const suggest = document.getElementById('pfSuggest');
  if (!suggest) return;
  if (val.length < 1) { suggest.innerHTML = ''; return; }

  const normalized = normalizeSymbol(val);
  if (normalized !== val.trim().toUpperCase()) {
    suggest.innerHTML = `<div class="pf-suggest-hint">→ ${normalized} として検索します</div>`;
  }

  _suggestTimer = setTimeout(async () => {
    const quote = await fetchQuoteSingle(normalized);
    suggest.innerHTML = '';
    if (quote) {
      const btn = document.createElement('button');
      btn.className = 'pf-suggest-item';
      btn.type = 'button';
      btn.innerHTML = `<span class="pf-suggest-sym">${normalized}</span> <span class="pf-suggest-name">${quote.name || ''}</span> <span class="pf-suggest-price">${fmt(quote.price, quote.currency)}</span>`;
      btn.addEventListener('click', () => {
        document.getElementById('pfTickerInput').value = normalized;
        suggest.innerHTML = '';
        const nextFocus = document.getElementById('pfQtyInput') || document.getElementById('pfRecAmount');
        if (nextFocus) nextFocus.focus();
      });
      suggest.appendChild(btn);
    }
  }, 400);
}

// ─── ヒーロースパークライン ──────────────────────────────
async function loadHeroSparkline(period) {
  const items = loadPortfolio();
  if (!items.length) return;

  const first = items[0];
  const rangeMap = {
    '1D': ['1d', '5m'],
    '1W': ['5d', '1h'],
    '1M': ['1mo', '1d'],
    '3M': ['3mo', '1d'],
    '1Y': ['1y', '1wk'],
    'ALL': ['max', '1mo'],
  };
  const [range, interval] = rangeMap[period] || ['1mo', '1d'];
  const hist = await fetchHistory(first.symbol, range, interval);
  if (hist) {
    const firstPrice = hist[0]?.c || 0;
    const lastPrice = hist[hist.length - 1]?.c || 0;
    const color = lastPrice >= firstPrice ? '#00c853' : '#ff3b30';
    renderSparkline('pfSparkline', hist, color);
  }
}

// ─── 自動更新 ────────────────────────────────────────────
function startAutoRefresh(intervalMs = 30000) {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => {
    _quoteCacheTime = 0;
    render();
    updateLastRefreshTime();
  }, intervalMs);
}

function updateLastRefreshTime() {
  const el = document.getElementById('pfLastUpdate');
  if (el) el.textContent = '最終更新: ' + new Date().toLocaleTimeString('ja-JP');
}

// ─── モード切替 ──────────────────────────────────────────
function switchMode(mode) {
  _currentMode = mode;

  document.querySelectorAll('.pf-mode-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const holdingsSection = document.getElementById('pfHoldingsSection');
  const recurringSection = document.getElementById('pfRecurringSection');
  if (holdingsSection) holdingsSection.hidden = mode !== 'holdings';
  if (recurringSection) recurringSection.hidden = mode !== 'recurring';

  render();
}

// ─── 初期化 ───────────────────────────────────────────────
function initPortfolio() {
  // モードタブ
  document.querySelectorAll('.pf-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // FABボタン
  document.getElementById('pfAddBtn')?.addEventListener('click', () => openModal(null, _currentMode));

  // モーダル閉じる
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', closeModal);
  });

  // 保存ボタン
  document.getElementById('pfSaveBtn')?.addEventListener('click', saveHolding);

  // フォームモード切替ラジオ
  document.querySelectorAll('input[name="pfFormMode"]').forEach(radio => {
    radio.addEventListener('change', e => toggleFormMode(e.target.value));
  });

  // Enterキーで保存
  document.getElementById('pfModal')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveHolding();
    }
    if (e.key === 'Escape') closeModal();
  });

  // ティッカー入力
  document.getElementById('pfTickerInput')?.addEventListener('input', onTickerInput);

  // ソート
  document.getElementById('pfSortSelect')?.addEventListener('change', e => {
    _sortMode = e.target.value;
    const items = loadPortfolio();
    if (!items.length) return;
    fetchQuotes(items.map(i => i.symbol)).then(quotes => renderHoldingsList(items, quotes));
  });

  // ドーナツ切替
  document.querySelectorAll('.pf-allocation-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pf-allocation-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _donutMode = btn.dataset.mode;
      const items = loadPortfolio();
      if (!items.length) return;
      fetchQuotes(items.map(i => i.symbol)).then(quotes => renderDonut(items, quotes, _donutMode));
    });
  });

  // 期間タブ
  document.querySelectorAll('.pf-period-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pf-period-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadHeroSparkline(btn.dataset.period);
    });
  });

  // Page Visibility API: タブ復帰時に再取得
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      _quoteCacheTime = 0;
      render();
      updateLastRefreshTime();
    }
  });

  // 初回レンダリング
  render().then(() => {
    loadHeroSparkline('1M');
    updateLastRefreshTime();
  });

  // 自動更新 (30秒)
  startAutoRefresh(30000);
}

document.addEventListener('DOMContentLoaded', initPortfolio);
