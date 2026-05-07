/**
 * portfolio.js
 * ポートフォリオ管理 — LocalStorage + Yahoo Finance 非公式API
 */

'use strict';

// ─── ストレージ ───────────────────────────────────────────
const STORAGE_KEY = 'portfolio_v1';

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

// ─── Yahoo Finance API（CORS プロキシ付き） ──────────────
const PROXY_LIST = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

let _quoteCache = {};
let _quoteCacheTime = 0;
const CACHE_TTL = 25000; // 25秒

async function fetchWithProxy(url) {
  for (const makeProxy of PROXY_LIST) {
    try {
      const res = await fetch(makeProxy(url), { signal: AbortSignal.timeout(8000) });
      if (res.ok) return res;
    } catch (e) {
      // 次のプロキシを試す
    }
  }
  throw new Error('全プロキシ失敗');
}

async function fetchQuotes(symbols) {
  if (!symbols.length) return {};
  const now = Date.now();
  if (now - _quoteCacheTime < CACHE_TTL) return _quoteCache;

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&lang=ja&region=JP`;
  try {
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const map = {};
    for (const q of (json.quoteResponse?.result || [])) {
      map[q.symbol] = {
        price: q.regularMarketPrice,
        prevClose: q.regularMarketPreviousClose,
        change: q.regularMarketChange,
        changePct: q.regularMarketChangePercent,
        currency: q.currency || 'JPY',
        name: q.shortName || q.longName || q.symbol,
        sector: q.sector || 'Unknown',
      };
    }
    _quoteCache = map;
    _quoteCacheTime = now;
    return map;
  } catch (e) {
    console.warn('fetchQuotes 失敗:', e);
    showApiError(true);
    return _quoteCache; // 前回値を返す
  }
}

async function fetchHistory(symbol, range = '1mo', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  try {
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const chart = json.chart?.result?.[0];
    if (!chart) return null;
    const ts = chart.timestamp || [];
    const closes = chart.indicators?.quote?.[0]?.close || [];
    return ts.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter(d => d.c != null);
  } catch (e) {
    console.warn('fetchHistory 失敗:', e);
    return null;
  }
}

function showApiError(show) {
  const el = document.getElementById('pfApiError');
  if (el) el.hidden = !show;
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

  // グラデーション fill
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

  // fill path
  const lastX = (prices.length - 1) / (prices.length - 1) * W;
  const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  fillPath.setAttribute('d', `M${pts.join('L')} L${lastX},${H} L0,${H} Z`);
  fillPath.setAttribute('fill', `url(#spark-grad-${containerId})`);
  svg.appendChild(fillPath);

  // line
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

async function render() {
  const items = loadPortfolio();
  const pfEmpty = document.getElementById('pfEmpty');
  const pfList = document.getElementById('pfList');
  const pfHoldingCount = document.getElementById('pfHoldingCount');

  if (!items.length) {
    if (pfEmpty) pfEmpty.hidden = false;
    if (pfList) pfList.innerHTML = '';
    document.getElementById('pfTotalValue').textContent = '¥ 0';
    document.getElementById('pfTotalDelta').className = 'pf-hero__delta';
    document.querySelector('.pf-delta-amount').textContent = '+¥ 0';
    document.querySelector('.pf-delta-pct').textContent = '(+0.00%)';
    if (pfHoldingCount) pfHoldingCount.textContent = '0';
    return;
  }

  if (pfEmpty) pfEmpty.hidden = true;
  showApiError(false);

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
  const dayChangePct = totalCost > 0 ? (totalDayChange / totalCost) * 100 : 0;

  // 総評価額（アニメーション）
  const heroVal = document.getElementById('pfTotalValue');
  if (heroVal) {
    animateNumber(heroVal, _prevTotal, totalValue, 800, v => {
      const c = Object.values(quotes)[0]?.currency || 'JPY';
      return fmt(v, c);
    });
  }
  _prevTotal = totalValue;

  // デルタ
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

  // ─── ドーナツ ───
  renderDonut(items, quotes, _donutMode);

  // ─── ホールディングスリスト ───
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
    // alpha
    return a.symbol.localeCompare(b.symbol);
  });

  // 既存の行を保持（展開状態を維持）
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

// ─── FAB & モーダル ──────────────────────────────────────
function openModal(edit = null) {
  const modal = document.getElementById('pfModal');
  if (!modal) return;
  modal.hidden = false;
  document.getElementById('pfTickerInput').value = edit?.symbol || '';
  document.getElementById('pfQtyInput').value = edit?.qty || '';
  document.getElementById('pfAvgInput').value = edit?.avgCost || '';
  document.getElementById('pfSuggest').innerHTML = '';
  document.getElementById('pfTickerInput').focus();
  modal.dataset.editing = edit?.symbol || '';
}

function openEditModal(item) {
  openModal(item);
}

function closeModal() {
  const modal = document.getElementById('pfModal');
  if (modal) {
    modal.hidden = true;
    document.getElementById('pfSuggest').innerHTML = '';
  }
}

async function saveHolding() {
  const ticker = document.getElementById('pfTickerInput').value.trim().toUpperCase();
  const qty = parseFloat(document.getElementById('pfQtyInput').value);
  const avgCost = parseFloat(document.getElementById('pfAvgInput').value);

  if (!ticker) { alert('ティッカーを入力してください'); return; }
  if (!qty || qty <= 0) { alert('数量を正しく入力してください'); return; }
  if (!avgCost || avgCost <= 0) { alert('平均取得単価を正しく入力してください'); return; }

  const saveBtn = document.getElementById('pfSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '確認中…';

  // 銘柄確認
  const quotes = await fetchQuotes([ticker]);
  const q = quotes[ticker];
  if (!q) {
    alert(`銘柄「${ticker}」が見つかりませんでした。\nティッカーを確認してください。`);
    saveBtn.disabled = false;
    saveBtn.textContent = '追加';
    return;
  }

  const items = loadPortfolio();
  const editingSymbol = document.getElementById('pfModal').dataset.editing;
  const existing = items.findIndex(i => i.symbol === ticker);

  const newItem = {
    symbol: ticker,
    qty,
    avgCost,
    name: q.name || ticker,
    addedAt: new Date().toISOString(),
  };

  if (editingSymbol && editingSymbol !== ticker) {
    // シンボル変更 → 古いのを削除
    const oldIdx = items.findIndex(i => i.symbol === editingSymbol);
    if (oldIdx >= 0) items.splice(oldIdx, 1);
  }

  if (existing >= 0 && editingSymbol === ticker) {
    items[existing] = newItem;
  } else if (existing >= 0) {
    // 同じシンボルが既にある → 確認
    if (!confirm(`${ticker} は既に登録されています。上書きしますか？`)) {
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

// ─── ティッカーサジェスト ────────────────────────────────
let _suggestTimer = null;

async function onTickerInput() {
  clearTimeout(_suggestTimer);
  const val = document.getElementById('pfTickerInput').value.trim().toUpperCase();
  const suggest = document.getElementById('pfSuggest');
  if (!suggest) return;
  if (val.length < 1) { suggest.innerHTML = ''; return; }

  _suggestTimer = setTimeout(async () => {
    const quotes = await fetchQuotes([val]);
    suggest.innerHTML = '';
    if (quotes[val]) {
      const q = quotes[val];
      const btn = document.createElement('button');
      btn.className = 'pf-suggest-item';
      btn.type = 'button';
      btn.innerHTML = `<span class="pf-suggest-sym">${val}</span> <span class="pf-suggest-name">${q.name || ''}</span> <span class="pf-suggest-price">${fmt(q.price, q.currency)}</span>`;
      btn.addEventListener('click', () => {
        document.getElementById('pfTickerInput').value = val;
        suggest.innerHTML = '';
        document.getElementById('pfQtyInput').focus();
      });
      suggest.appendChild(btn);
    }
  }, 400);
}

// ─── ヒーロースパークライン ──────────────────────────────
async function loadHeroSparkline(period) {
  const items = loadPortfolio();
  if (!items.length) return;

  // 最初の銘柄のチャートを代表として表示（TODO: ポートフォリオ合算）
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
    const quotes = await fetchQuotes(items.map(i => i.symbol));
    const q = quotes[first.symbol] || {};
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
    _quoteCacheTime = 0; // キャッシュ強制更新
    render();
    updateLastRefreshTime();
  }, intervalMs);
}

function updateLastRefreshTime() {
  const el = document.getElementById('pfLastUpdate');
  if (el) el.textContent = '最終更新: ' + new Date().toLocaleTimeString('ja-JP');
}

// ─── 初期化 ───────────────────────────────────────────────
function initPortfolio() {
  // FABボタン
  document.getElementById('pfAddBtn')?.addEventListener('click', () => openModal());

  // モーダル閉じる
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', closeModal);
  });

  // 保存ボタン
  document.getElementById('pfSaveBtn')?.addEventListener('click', saveHolding);

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

  // 初回レンダリング
  render().then(() => {
    loadHeroSparkline('1M');
    updateLastRefreshTime();
  });

  // 自動更新 (30秒)
  startAutoRefresh(30000);
}

document.addEventListener('DOMContentLoaded', initPortfolio);
