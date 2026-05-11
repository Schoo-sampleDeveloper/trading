/**
 * portfolio.js
 * ポートフォリオ管理 — LocalStorage + Yahoo Finance (Cloudflare Worker経由)
 */

'use strict';

// ─── 定数 ─────────────────────────────────────────────────
const WORKER_BASE = 'https://yahoo-proxy.kazuki35344.workers.dev';
const STORAGE_KEY = 'portfolio_v1';
const STORAGE_KEY_RECURRING = 'portfolio_recurring_v2';

// フォールバック年利（自動算出失敗時）
const FALLBACK_ANNUAL_RETURNS = {
  'VOO': 0.10, '^GSPC': 0.10, 'SPY': 0.10,
  'VT': 0.08,
  'QQQ': 0.13,
  'VTI': 0.105,
  '1321.T': 0.05, '1306.T': 0.05, '^N225': 0.05,
  'VEA': 0.07,
  'VWO': 0.08,
  'BND': 0.03, 'AGG': 0.03,
  'GLD': 0.06, 'IAU': 0.06,
};

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
    const v2 = JSON.parse(localStorage.getItem(STORAGE_KEY_RECURRING) || 'null');
    if (v2 !== null) return v2;

    // v1 → v2 移行
    const v1 = JSON.parse(localStorage.getItem('portfolio_recurring_v1') || '[]');
    if (v1.length) {
      const migrated = v1.map(old => ({
        id: old.symbol + '_' + Date.now(),
        symbol: old.symbol,
        name: old.name || old.symbol,
        monthlyAmount: old.monthlyAmount || 30000,
        startMonth: old.startMonth || '2024-01',
        autoAnnualReturn: null,
        userAnnualReturn: null,
        simYears: 30,
        lastFetchedAt: null,
      }));
      localStorage.setItem(STORAGE_KEY_RECURRING, JSON.stringify(migrated));
      return migrated;
    }
    return [];
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
function normalizeSymbol(input) {
  const s = input.trim().toUpperCase();
  if (/^\d{4}$/.test(s)) return s + '.T';
  return s;
}

async function validateSymbol(input) {
  const normalized = normalizeSymbol(input);
  const candidates = [normalized];

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

// ─── トースト通知 ─────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  let toast = document.getElementById('pfToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'pfToast';
    toast.className = 'pf-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ─── モーダル制御 ─────────────────────────────────────────
function escHandler(e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.pf-modal:not([hidden])').forEach(m => hideModal(m));
  }
}

function showModal(modalEl) {
  modalEl.hidden = false;
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.width = '100%';
  document.body.dataset.scrollY = String(window.scrollY);
  document.addEventListener('keydown', escHandler);

  // バックドロップ・×・キャンセルに直接バインド（デリゲーション失敗時の保険）
  modalEl.querySelectorAll('[data-close]').forEach(el => {
    el.onclick = (e) => {
      console.log('[pf] direct close click:', el.className);
      e.preventDefault();
      e.stopPropagation();
      hideModal(modalEl);
    };
  });

  const firstInput = modalEl.querySelector('input:not([disabled])');
  if (firstInput) {
    setTimeout(() => firstInput.focus(), 100);
  }
}

function hideModal(modalEl) {
  console.log('[pf] hideModal called:', modalEl?.id, 'currently hidden:', modalEl?.hidden);
  if (!modalEl) {
    console.error('[pf] hideModal: modalEl is null/undefined');
    return;
  }
  modalEl.hidden = true;
  console.log('[pf] hideModal: set hidden=true, now:', modalEl.hidden);

  // iOS Safari スクロール位置復元
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.width = '';
  const y = parseInt(document.body.dataset.scrollY || '0', 10);
  window.scrollTo(0, y);

  document.removeEventListener('keydown', escHandler);

  // 編集フラグをクリア
  modalEl.dataset.editingId = '';

  // disabled 解除
  modalEl.querySelectorAll('input[type="text"]').forEach(i => { i.disabled = false; });

  // 全入力をクリア
  modalEl.querySelectorAll('input').forEach(i => { i.value = ''; });

  // タイトル / ボタン文言をリセット
  const title = modalEl.querySelector('.pf-modal__title');
  if (modalEl.id === 'pfModalHoldings') {
    if (title) title.textContent = '銘柄を追加';
    const btn = modalEl.querySelector('#pfSaveHoldingsBtn');
    if (btn) { btn.textContent = '追加'; btn.disabled = false; }
  } else if (modalEl.id === 'pfModalRecurring') {
    if (title) title.textContent = '積立を追加';
    const btn = modalEl.querySelector('#pfSaveRecurringBtn');
    if (btn) { btn.textContent = '追加'; btn.disabled = false; }
    // プリセットの active 解除
    modalEl.querySelectorAll('.pf-preset.active').forEach(p => p.classList.remove('active'));
  } else if (modalEl.id === 'pfModalAnnualReturn') {
    const btn = modalEl.querySelector('#pfSaveARBtn');
    if (btn) { btn.disabled = false; }
    const resetChk = modalEl.querySelector('#pfARReset');
    if (resetChk) resetChk.checked = false;
    const input = modalEl.querySelector('#pfARInput');
    if (input) input.disabled = false;
  }

  // サジェストクリア
  modalEl.querySelectorAll('.pf-suggest').forEach(s => { s.innerHTML = ''; });
}

// ─── Holdings モーダル ────────────────────────────────────
function openHoldingsModal() {
  const modal = document.getElementById('pfModalHoldings');
  if (!modal) return;
  modal.dataset.editingId = '';
  showModal(modal);
}

function openEditHoldingsModal(item) {
  const modal = document.getElementById('pfModalHoldings');
  if (!modal) return;
  modal.dataset.editingId = item.symbol;

  document.getElementById('pfHTickerInput').value = item.symbol;
  document.getElementById('pfHTickerInput').disabled = true;
  document.getElementById('pfHQtyInput').value = item.qty;
  document.getElementById('pfHAvgInput').value = item.avgCost;

  const title = modal.querySelector('.pf-modal__title');
  if (title) title.textContent = '銘柄を編集';
  const btn = modal.querySelector('#pfSaveHoldingsBtn');
  if (btn) btn.textContent = '保存';

  showModal(modal);
}

// Holdings ティッカーサジェスト
let _hSuggestTimer = null;
function onHTickerInput() {
  clearTimeout(_hSuggestTimer);
  const val = document.getElementById('pfHTickerInput').value.trim();
  const suggest = document.getElementById('pfHSuggest');
  if (!suggest) return;
  if (val.length < 1) { suggest.innerHTML = ''; return; }

  const normalized = normalizeSymbol(val);
  if (normalized !== val.trim().toUpperCase()) {
    suggest.innerHTML = `<div class="pf-suggest-hint">→ ${normalized} として検索します</div>`;
  } else {
    suggest.innerHTML = '';
  }

  _hSuggestTimer = setTimeout(async () => {
    const quote = await fetchQuoteSingle(normalized);
    suggest.innerHTML = '';
    if (quote) {
      const btn = document.createElement('button');
      btn.className = 'pf-suggest-item';
      btn.type = 'button';
      btn.innerHTML = `<span class="pf-suggest-sym">${normalized}</span>
        <span class="pf-suggest-name">${quote.name || ''}</span>
        <span class="pf-suggest-price">${fmt(quote.price, quote.currency)}</span>`;
      btn.addEventListener('click', () => {
        document.getElementById('pfHTickerInput').value = normalized;
        suggest.innerHTML = '';
        document.getElementById('pfHQtyInput').focus();
      });
      suggest.appendChild(btn);
    }
  }, 400);
}

async function onSaveHoldings() {
  const modal = document.getElementById('pfModalHoldings');
  const editingId = modal.dataset.editingId;

  const tickerEl = document.getElementById('pfHTickerInput');
  const qtyEl    = document.getElementById('pfHQtyInput');
  const avgEl    = document.getElementById('pfHAvgInput');

  const ticker  = tickerEl.value.trim();
  const qty     = parseFloat(qtyEl.value);
  const avgCost = parseFloat(avgEl.value);

  if (!ticker)            { showToast('ティッカーを入力してください', 'error'); tickerEl.focus(); return; }
  if (!qty || qty <= 0)   { showToast('数量を正しく入力してください', 'error'); qtyEl.focus(); return; }
  if (!avgCost || avgCost <= 0) { showToast('平均取得単価を正しく入力してください', 'error'); avgEl.focus(); return; }

  const saveBtn = document.getElementById('pfSaveHoldingsBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '確認中…';

  try {
    const validation = await validateSymbol(ticker);
    let finalSymbol = validation.symbol;
    let finalName   = validation.quote?.name || finalSymbol;

    if (!validation.ok) {
      const proceed = confirm(
        `「${validation.tried.join('」「')}」の価格データが取得できませんでした。それでも登録しますか？`
      );
      if (!proceed) return;
      finalName = finalSymbol;
    }

    const items = loadPortfolio();
    const existing = items.findIndex(i => i.symbol === finalSymbol);
    const newItem = {
      symbol: finalSymbol,
      qty,
      avgCost,
      name: finalName,
      addedAt: new Date().toISOString(),
    };

    if (editingId && editingId !== finalSymbol) {
      const oldIdx = items.findIndex(i => i.symbol === editingId);
      if (oldIdx >= 0) items.splice(oldIdx, 1);
    }

    if (existing >= 0 && editingId === finalSymbol) {
      items[existing] = newItem;
    } else if (existing >= 0) {
      if (!confirm(`${finalSymbol} は既に登録されています。上書きしますか？`)) return;
      items[existing] = newItem;
    } else {
      items.push(newItem);
    }

    savePortfolio(items);
    _quoteCache = {};
    _quoteCacheTime = 0;
    hideModal(modal);
    showToast(`${finalSymbol} を追加しました`, 'success');
    await render();
  } catch (e) {
    console.error(e);
    showToast('登録に失敗しました', 'error');
  } finally {
    // モーダルがまだ開いている場合のみボタンを復元
    if (!modal.hidden) {
      saveBtn.disabled = false;
      saveBtn.textContent = editingId ? '保存' : '追加';
    }
  }
}

// ─── 年利自動算出 ────────────────────────────────────────
async function fetchAutoAnnualReturn(symbol) {
  const fallback = FALLBACK_ANNUAL_RETURNS[symbol] ?? 0.07;
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
      const valid = closes.filter(c => c != null && c > 0);
      if (valid.length < 12) continue;

      // 月次リターン → 幾何平均 → 年率換算
      let product = 1;
      let n = 0;
      for (let i = 1; i < valid.length; i++) {
        const r = valid[i] / valid[i - 1] - 1;
        product *= (1 + r);
        n++;
      }
      if (n < 12) continue;
      const monthlyGeomean = Math.pow(product, 1 / n) - 1;
      const annualReturn = Math.pow(1 + monthlyGeomean, 12) - 1;

      // 合理的な範囲チェック (-50% 〜 +100%)
      if (annualReturn < -0.5 || annualReturn > 1.0) continue;
      return annualReturn;
    } catch (e) {
      continue;
    }
  }
  return fallback;
}

// ─── シミュレーション計算 ────────────────────────────────
function calcSimulationArrays(item) {
  const annualReturn = item.userAnnualReturn ?? item.autoAnnualReturn ?? 0.07;
  const simYears = item.simYears || 30;
  const totalMonths = simYears * 12;
  const monthlyAmount = item.monthlyAmount;
  const r = Math.pow(1 + annualReturn, 1 / 12) - 1; // 月利

  const principal = [];
  const value = [];
  for (let i = 1; i <= totalMonths; i++) {
    principal.push(monthlyAmount * i);
    if (r === 0) {
      value.push(monthlyAmount * i);
    } else {
      value.push(monthlyAmount * ((Math.pow(1 + r, i) - 1) / r) * (1 + r));
    }
  }
  return { principal, value, totalMonths, annualReturn, simYears };
}

function getElapsedMonths(startMonth) {
  const [sy, sm] = startMonth.split('-').map(Number);
  const now = new Date();
  const ny = now.getFullYear();
  const nm = now.getMonth() + 1;
  const elapsed = (ny - sy) * 12 + (nm - sm);
  return Math.max(0, elapsed);
}

function fmtJPYShort(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(1) + '億';
  if (abs >= 1e4) return Math.round(n / 1e4) + '万';
  return Math.round(n).toLocaleString('ja-JP');
}

function formatYAxisJPY(val) {
  const abs = Math.abs(val);
  if (abs >= 1e12) return (val / 1e12).toFixed(1) + '兆';
  if (abs >= 1e8)  return (val / 1e8).toFixed(1) + '億';
  if (abs >= 1e4)  return (val / 1e4).toFixed(0) + '万';
  return val.toString();
}

function formatJPY(val) {
  return Math.round(val).toLocaleString('ja-JP');
}

// ─── Recurring モーダル ───────────────────────────────────
function openRecurringModal() {
  const modal = document.getElementById('pfModalRecurring');
  if (!modal) return;
  modal.dataset.editingId = '';

  // デフォルト開始月: 当月
  const now = new Date();
  document.getElementById('pfRStartInput').value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('pfRUserReturnInput').value = '';
  const simYearsEl = document.getElementById('pfRSimYearsSelect');
  if (simYearsEl) simYearsEl.value = '30';

  showModal(modal);
}

function openEditRecurringModal(item) {
  const modal = document.getElementById('pfModalRecurring');
  if (!modal) return;
  modal.dataset.editingId = item.id || item.symbol;

  document.getElementById('pfRTickerInput').value = item.symbol;
  document.getElementById('pfRTickerInput').disabled = true;
  document.getElementById('pfRAmountInput').value = item.monthlyAmount;
  document.getElementById('pfRStartInput').value  = item.startMonth;
  document.getElementById('pfRUserReturnInput').value =
    item.userAnnualReturn != null ? (item.userAnnualReturn * 100).toFixed(1) : '';
  const simYearsEl = document.getElementById('pfRSimYearsSelect');
  if (simYearsEl) simYearsEl.value = String(item.simYears || 30);

  // プリセットのアクティブ状態を更新
  document.querySelectorAll('.pf-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.symbol === item.symbol);
  });

  const title = modal.querySelector('.pf-modal__title');
  if (title) title.textContent = '積立を編集';
  const btn = modal.querySelector('#pfSaveRecurringBtn');
  if (btn) btn.textContent = '保存';

  showModal(modal);
}

// Recurring ティッカーサジェスト
let _rSuggestTimer = null;
function onRTickerInput() {
  clearTimeout(_rSuggestTimer);
  const val = document.getElementById('pfRTickerInput').value.trim();
  const suggest = document.getElementById('pfRSuggest');
  if (!suggest) return;
  if (val.length < 1) { suggest.innerHTML = ''; return; }

  const normalized = normalizeSymbol(val);
  if (normalized !== val.trim().toUpperCase()) {
    suggest.innerHTML = `<div class="pf-suggest-hint">→ ${normalized} として検索します</div>`;
  } else {
    suggest.innerHTML = '';
  }

  _rSuggestTimer = setTimeout(async () => {
    const quote = await fetchQuoteSingle(normalized);
    suggest.innerHTML = '';
    if (quote) {
      const btn = document.createElement('button');
      btn.className = 'pf-suggest-item';
      btn.type = 'button';
      btn.innerHTML = `<span class="pf-suggest-sym">${normalized}</span>
        <span class="pf-suggest-name">${quote.name || ''}</span>
        <span class="pf-suggest-price">${fmt(quote.price, quote.currency)}</span>`;
      btn.addEventListener('click', () => {
        document.getElementById('pfRTickerInput').value = normalized;
        suggest.innerHTML = '';
        document.getElementById('pfRAmountInput').focus();
      });
      suggest.appendChild(btn);
    }
  }, 400);
}

async function onSaveRecurring() {
  const modal = document.getElementById('pfModalRecurring');
  const editingId = modal.dataset.editingId;

  const tickerEl     = document.getElementById('pfRTickerInput');
  const amountEl     = document.getElementById('pfRAmountInput');
  const startEl      = document.getElementById('pfRStartInput');
  const userReturnEl = document.getElementById('pfRUserReturnInput');
  const simYearsEl   = document.getElementById('pfRSimYearsSelect');

  const ticker        = tickerEl.value.trim();
  const monthlyAmount = parseFloat(amountEl.value);
  const startMonth    = startEl.value;
  const userReturnRaw = userReturnEl ? userReturnEl.value.trim() : '';
  const userAnnualReturn = userReturnRaw !== '' ? parseFloat(userReturnRaw) / 100 : null;
  const simYears      = simYearsEl ? parseInt(simYearsEl.value, 10) : 30;

  if (!ticker) {
    showToast('ティッカーを入力してください', 'error');
    tickerEl.focus();
    return;
  }
  if (isNaN(monthlyAmount) || monthlyAmount < 1000) {
    showToast('積立額は 1,000 円以上で入力してください', 'error');
    amountEl.focus();
    return;
  }
  if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) {
    showToast('開始月を選択してください', 'error');
    return;
  }
  if (new Date(startMonth + '-01') < new Date('1990-01-01')) {
    showToast('開始月は1990年以降を選択してください', 'error');
    return;
  }
  if (userAnnualReturn !== null && (isNaN(userAnnualReturn) || userAnnualReturn < -0.5 || userAnnualReturn > 2)) {
    showToast('年利は -50% 〜 200% の範囲で入力してください', 'error');
    return;
  }

  const saveBtn = document.getElementById('pfSaveRecurringBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '確認中…';

  try {
    const validation = await validateSymbol(ticker);
    let finalSymbol = validation.symbol;
    let finalName   = validation.quote?.name || finalSymbol;

    if (!validation.ok) {
      const proceed = confirm(
        `「${validation.tried.join('」「')}」の価格データが取得できませんでした。それでも登録しますか？`
      );
      if (!proceed) return;
      finalName = finalSymbol;
    }

    const items = loadRecurring();
    const existingIdx = items.findIndex(i => i.id === editingId || (!editingId && i.symbol === finalSymbol));

    const newItem = {
      id: editingId && items[existingIdx]?.id ? items[existingIdx].id : (crypto.randomUUID?.() || finalSymbol + '_' + Date.now()),
      symbol: finalSymbol,
      name: finalName,
      monthlyAmount,
      startMonth,
      autoAnnualReturn: items[existingIdx]?.autoAnnualReturn ?? null,
      userAnnualReturn,
      simYears,
      lastFetchedAt: items[existingIdx]?.lastFetchedAt ?? null,
    };

    if (existingIdx >= 0) {
      items[existingIdx] = newItem;
    } else {
      items.push(newItem);
    }

    saveRecurring(items);
    hideModal(modal);
    showToast(`${finalSymbol} の積立を追加しました`, 'success');
    await renderRecurring();
  } catch (e) {
    console.error(e);
    showToast('登録に失敗しました', 'error');
  } finally {
    if (!modal.hidden) {
      saveBtn.disabled = false;
      saveBtn.textContent = editingId ? '保存' : '追加';
    }
  }
}

// ─── メインレンダリング ───────────────────────────────────
let _prevTotal = 0;
let _donutMode = 'symbol';
let _sortMode  = 'value';
let _refreshTimer = null;
let _currentMode  = 'holdings'; // 'holdings' | 'recurring'

async function render() {
  if (_currentMode === 'recurring') {
    await renderRecurring();
    return;
  }

  const items = loadPortfolio();
  const pfEmpty        = document.getElementById('pfEmpty');
  const pfList         = document.getElementById('pfList');
  const pfHoldingCount = document.getElementById('pfHoldingCount');

  if (!items.length) {
    if (pfEmpty) pfEmpty.hidden = false;
    if (pfList)  pfList.innerHTML = '';
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

  let totalValue = 0;
  let totalCost  = 0;

  items.forEach(item => {
    const q = quotes[item.symbol];
    if (!q) return;
    const { market, cost } = calcPnL(item, q);
    totalValue += market;
    totalCost  += cost;
  });

  const totalPnL    = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  const heroVal = document.getElementById('pfTotalValue');
  if (heroVal) {
    animateNumber(heroVal, _prevTotal, totalValue, 800, v => {
      const c = Object.values(quotes)[0]?.currency || 'JPY';
      return fmt(v, c);
    });
  }
  _prevTotal = totalValue;

  const heroD    = document.getElementById('pfTotalDelta');
  const deltaAmt = document.querySelector('.pf-delta-amount');
  const deltaPct = document.querySelector('.pf-delta-pct');
  const currency = Object.values(quotes)[0]?.currency || 'JPY';

  if (heroD) heroD.className = 'pf-hero__delta ' + (totalPnL >= 0 ? 'up' : 'down');
  const arrow = document.querySelector('.pf-arrow');
  if (arrow)    arrow.textContent    = totalPnL >= 0 ? '▲' : '▼';
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

  // 展開状態を保持
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
    const li    = clone.querySelector('.pf-row');

    li.dataset.symbol = item.symbol;
    li.style.setProperty('--i', idx);

    li.querySelector('.pf-row__symbol').textContent = item.symbol;
    li.querySelector('.pf-row__name').textContent   = q.name || item.name || '';
    li.querySelector('.pf-row__value').textContent  = fmt(market, cur);
    li.querySelector('.pf-row__qty').textContent    = fmtNum(item.qty, 4) + ' 株';

    const pnlEl = li.querySelector('.pf-row__pnl-pct');
    pnlEl.textContent = fmtPct(pnlPct);
    pnlEl.className   = 'pf-row__pnl-pct ' + (pnlPct >= 0 ? 'up' : 'down');

    const dayEl   = li.querySelector('.pf-row__day-change');
    const daySign = dayChange >= 0 ? '+' : '';
    dayEl.textContent = `${daySign}${fmt(dayChange, cur)} 今日`;
    dayEl.style.color = dayChange >= 0 ? 'var(--bullish)' : 'var(--bearish)';

    const expand = li.querySelector('.pf-row__expand');
    li.querySelector('.pf-d-qty').textContent    = fmtNum(item.qty, 4);
    li.querySelector('.pf-d-avg').textContent    = fmt(item.avgCost, cur);
    li.querySelector('.pf-d-last').textContent   = q.price != null ? fmt(q.price, cur) : '—';
    li.querySelector('.pf-d-day').textContent    = `${daySign}${fmtPct(dayChangePct)}`;
    li.querySelector('.pf-d-day').style.color    = dayChange >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    li.querySelector('.pf-d-pnl').textContent    = (pnl >= 0 ? '+' : '') + fmt(pnl, cur);
    li.querySelector('.pf-d-pnl').style.color    = pnl >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    li.querySelector('.pf-d-pnlpct').textContent = fmtPct(pnlPct);
    li.querySelector('.pf-d-pnlpct').style.color = pnlPct >= 0 ? 'var(--bullish)' : 'var(--bearish)';

    if (expandedSet.has(item.symbol)) expand.hidden = false;

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
          renderSparkline(chartId, hist, pnlPct >= 0 ? '#00c853' : '#ff3b30');
        });
      }
    });

    li.querySelector('.pf-edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditHoldingsModal(item);
    });

    li.querySelector('.pf-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteHolding(item.symbol);
    });

    pfList.appendChild(clone);
  });
}

// ─── 削除 ─────────────────────────────────────────────────
function deleteHolding(symbol) {
  const items = loadPortfolio().filter(i => i.symbol !== symbol);
  savePortfolio(items);
  _quoteCache    = {};
  _quoteCacheTime = 0;
  render();
}

function deleteRecurring(id) {
  const items = loadRecurring().filter(i => (i.id || i.symbol) !== id);
  saveRecurring(items);
  renderRecurring();
}

// ─── Recurring Chart.js グラフ ───────────────────────────
const _recCharts = {};

function renderRecurringChart(canvasEl, item, elapsedMonths) {
  const canvasId = canvasEl.id;
  if (_recCharts[canvasId]) {
    _recCharts[canvasId].destroy();
    delete _recCharts[canvasId];
  }

  // annotation プラグイン登録
  if (window['chartjs-plugin-annotation']) {
    try { Chart.register(window['chartjs-plugin-annotation']); } catch(e) { /* already registered */ }
  }

  const { principal, value, totalMonths, annualReturn, simYears } = calcSimulationArrays(item);
  const startDate = new Date(item.startMonth + '-01');
  const startYear = startDate.getFullYear();

  // 年単位に集約（simYears+1 点: 開始〜simYears年後）
  const yearlyPrincipal = [];
  const yearlyValue = [];
  const yearlyLabels = [];

  for (let y = 0; y <= simYears; y++) {
    const monthIdx = y * 12 - 1; // y年経過時点の月インデックス（0-based）
    if (monthIdx < 0) {
      yearlyPrincipal.push(0);
      yearlyValue.push(0);
    } else if (monthIdx >= principal.length) {
      yearlyPrincipal.push(principal[principal.length - 1]);
      yearlyValue.push(value[value.length - 1]);
    } else {
      yearlyPrincipal.push(principal[monthIdx]);
      yearlyValue.push(value[monthIdx]);
    }
    yearlyLabels.push(y === 0 ? '開始' : `${y}年後`);
  }

  const elapsedYears = elapsedMonths / 12;
  const isNarrow = window.innerWidth < 640;

  function makeGradient(ctx, chartArea) {
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0,   'rgba(34, 197, 94, 0.35)');
    g.addColorStop(0.5, 'rgba(34, 197, 94, 0.08)');
    g.addColorStop(1,   'rgba(34, 197, 94, 0.00)');
    return g;
  }

  const ctx = canvasEl.getContext('2d');
  _recCharts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: yearlyLabels,
      datasets: [
        {
          label: '元本',
          data: yearlyPrincipal,
          borderColor: 'rgba(156, 163, 175, 0.9)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#9ca3af',
          fill: false,
          tension: 0,
        },
        {
          label: '予測評価額',
          data: yearlyValue,
          borderColor: '#22c55e',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#22c55e',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          fill: true,
          backgroundColor: function(context) {
            const chart = context.chart;
            const { ctx, chartArea } = chart;
            if (!chartArea) return null;
            return makeGradient(ctx, chartArea);
          },
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            boxWidth: 8,
            boxHeight: 8,
            padding: 12,
            font: { size: 12, family: "'JetBrains Mono', 'SF Mono', monospace" },
            color: 'rgba(255,255,255,0.7)',
          },
        },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#fff',
          bodyColor: 'rgba(255,255,255,0.85)',
          borderColor: 'rgba(34, 197, 94, 0.3)',
          borderWidth: 1,
          padding: 12,
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 12, family: "'JetBrains Mono', monospace" },
          cornerRadius: 8,
          displayColors: true,
          boxPadding: 4,
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const labelYear = startYear + idx;
              return idx === 0 ? `開始時点 (${labelYear})` : `${idx}年後 (${labelYear})`;
            },
            label: (ctx) => {
              const v = ctx.parsed.y;
              return `${ctx.dataset.label}: ¥${formatJPY(v)}`;
            },
            afterBody: (items) => {
              const principalItem = items.find(i => i.dataset.label === '元本');
              const valueItem     = items.find(i => i.dataset.label === '予測評価額');
              const p = principalItem?.parsed.y || 0;
              const v = valueItem?.parsed.y || 0;
              if (p === 0) return [];
              const profit   = v - p;
              const ratio    = ((v / p - 1) * 100).toFixed(1);
              const multiple = (v / p).toFixed(2);
              return [
                '',
                `損益: +¥${formatJPY(profit)} (+${ratio}%)`,
                `倍率: ×${multiple}`,
              ];
            },
          },
        },
        annotation: {
          annotations: {
            currentLine: {
              type: 'line',
              xMin: elapsedYears,
              xMax: elapsedYears,
              borderColor: 'rgba(239, 68, 68, 0.6)',
              borderWidth: 1.5,
              borderDash: [6, 6],
              label: {
                display: elapsedMonths > 0,
                content: '現在',
                position: 'start',
                backgroundColor: 'rgba(239, 68, 68, 0.9)',
                color: '#fff',
                font: { size: 10, weight: '600' },
                padding: 4,
                borderRadius: 4,
              },
            },
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
            drawBorder: false,
          },
          ticks: {
            color: 'rgba(255,255,255,0.5)',
            font: { size: 11, family: "'JetBrains Mono', monospace" },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: isNarrow ? 5 : 8,
            callback: function(val, idx) {
              if (idx === 0) return '開始';
              if (idx % 5 === 0) return `${idx}年後`;
              return '';
            },
          },
        },
        y: {
          grid: {
            color: 'rgba(255,255,255,0.05)',
            drawBorder: false,
          },
          ticks: {
            color: 'rgba(255,255,255,0.5)',
            font: { size: 11, family: "'JetBrains Mono', monospace" },
            padding: 8,
            callback: function(val) {
              return formatYAxisJPY(val);
            },
          },
          beginAtZero: true,
        },
      },
      animation: {
        duration: 800,
        easing: 'easeOutCubic',
      },
      elements: {
        line: { borderJoinStyle: 'round' },
      },
    },
  });
}

// ─── 年利変更モーダル ─────────────────────────────────────
let _annualReturnEditItem = null;

function openAnnualReturnModal(item) {
  _annualReturnEditItem = item;
  const modal = document.getElementById('pfModalAnnualReturn');
  if (!modal) return;

  const autoRate = item.autoAnnualReturn != null
    ? (item.autoAnnualReturn * 100).toFixed(2) + '%'
    : '算出中…';
  const autoInfo = document.getElementById('pfARAutoInfo');
  if (autoInfo) autoInfo.textContent = `自動算出値: ${autoRate}（${item.symbol}過去平均）`;

  const input = document.getElementById('pfARInput');
  if (input) input.value = item.userAnnualReturn != null ? (item.userAnnualReturn * 100).toFixed(1) : '';

  const resetChk = document.getElementById('pfARReset');
  if (resetChk) resetChk.checked = false;

  showModal(modal);
}

async function onSaveAnnualReturn() {
  if (!_annualReturnEditItem) return;
  const input    = document.getElementById('pfARInput');
  const resetChk = document.getElementById('pfARReset');
  const modal    = document.getElementById('pfModalAnnualReturn');

  let userRate = null;
  if (resetChk && resetChk.checked) {
    userRate = null;
  } else {
    const raw = input ? input.value.trim() : '';
    if (raw !== '') {
      const v = parseFloat(raw) / 100;
      if (isNaN(v) || v < -0.5 || v > 2) {
        showToast('年利は -50% 〜 200% の範囲で入力してください', 'error');
        return;
      }
      userRate = v;
    }
  }

  const items = loadRecurring();
  const idx   = items.findIndex(i => (i.id || i.symbol) === (_annualReturnEditItem.id || _annualReturnEditItem.symbol));
  if (idx >= 0) {
    items[idx].userAnnualReturn = userRate;
    saveRecurring(items);
  }
  hideModal(modal);
  _annualReturnEditItem = null;
  await renderRecurring();
}

// ─── Recurring レンダリング ──────────────────────────────
async function renderRecurring() {
  let items     = loadRecurring();
  const pfRecList  = document.getElementById('pfRecList');
  const pfRecEmpty = document.getElementById('pfRecEmpty');

  // Monte Carlo セレクター更新
  updateMcItemSelector();

  if (!items.length) {
    if (pfRecEmpty) pfRecEmpty.hidden = false;
    if (pfRecList)  pfRecList.innerHTML = '';
    // ヒーロークリア
    const heroVal = document.getElementById('pfRecHeroValue');
    const heroDelta = document.getElementById('pfRecHeroDelta');
    const invEl = document.getElementById('pfRecInvested');
    const curEl = document.getElementById('pfRecCurrent');
    const pnlEl = document.getElementById('pfRecPnL');
    if (heroVal)   heroVal.textContent   = '¥ 0';
    if (heroDelta) heroDelta.textContent = '';
    if (invEl) invEl.textContent = '¥ 0';
    if (curEl) curEl.textContent = '¥ 0';
    if (pnlEl) { pnlEl.textContent = '¥ 0 (+0.00%)'; pnlEl.style.color = ''; }
    return;
  }

  if (pfRecEmpty) pfRecEmpty.hidden = true;
  if (pfRecList)  pfRecList.innerHTML =
    '<li style="padding:16px;color:var(--text-muted);text-align:center;font-size:13px;">計算中...</li>';

  // 年利の自動算出（未取得 or 1日以上経過）
  const needFetch = items.filter(item =>
    item.autoAnnualReturn == null ||
    !item.lastFetchedAt ||
    Date.now() - item.lastFetchedAt > 86400000
  );
  if (needFetch.length) {
    await Promise.all(needFetch.map(async item => {
      const rate = await fetchAutoAnnualReturn(item.symbol);
      item.autoAnnualReturn = rate;
      item.lastFetchedAt   = Date.now();
    }));
    saveRecurring(items);
  }

  // 当日株価取得（dayChange 用）
  const quotes = await fetchQuotes(items.map(i => i.symbol));

  // 集計
  let totalCurrentValue = 0;
  let totalPrincipal    = 0;
  let totalDayChange    = 0;

  const simResults = items.map(item => {
    const elapsed = getElapsedMonths(item.startMonth);
    const { principal, value, totalMonths, annualReturn, simYears } = calcSimulationArrays(item);

    // 経過月インデックス（0-based: elapsed月後は配列のelapsed-1番目）
    const idx = Math.min(elapsed, totalMonths) - 1;
    const currPrincipal = elapsed > 0 ? principal[idx] : 0;
    const currValue     = elapsed > 0 ? value[idx]     : 0;

    // 当日変動
    const q        = quotes[item.symbol] || {};
    const dayChgPct = q.price && q.prevClose ? (q.price / q.prevClose - 1) : 0;
    const displayValue = currValue * (1 + dayChgPct);
    const dayChgAmt    = currValue * dayChgPct;

    // 30年後の最終値
    const finalPrincipal = principal[totalMonths - 1];
    const finalValue     = value[totalMonths - 1];

    totalCurrentValue += displayValue;
    totalPrincipal    += currPrincipal;
    totalDayChange    += dayChgAmt;

    return {
      item, elapsed, currPrincipal, currValue, displayValue, dayChgPct, dayChgAmt,
      annualReturn, simYears, totalMonths, finalPrincipal, finalValue,
      principal, value,
    };
  });

  // ヒーロー更新
  const heroVal   = document.getElementById('pfRecHeroValue');
  const heroDelta = document.getElementById('pfRecHeroDelta');
  const invEl     = document.getElementById('pfRecInvested');
  const curEl     = document.getElementById('pfRecCurrent');
  const pnlEl     = document.getElementById('pfRecPnL');

  const totalPnL    = totalCurrentValue - totalPrincipal;
  const totalPnLPct = totalPrincipal > 0 ? (totalPnL / totalPrincipal) * 100 : 0;
  const dayChgPct   = totalCurrentValue > 0 ? (totalDayChange / (totalCurrentValue - totalDayChange)) * 100 : 0;

  if (heroVal) heroVal.textContent = fmt(totalCurrentValue, 'JPY');
  if (heroDelta) {
    const sign = totalDayChange >= 0 ? '+' : '';
    heroDelta.textContent = `${sign}${fmt(totalDayChange, 'JPY')} (${sign}${dayChgPct.toFixed(2)}%) 本日`;
    heroDelta.style.color = totalDayChange >= 0 ? 'var(--bullish)' : 'var(--bearish)';
  }
  if (invEl) invEl.textContent = fmt(totalPrincipal, 'JPY');
  if (curEl) curEl.textContent = fmt(totalCurrentValue, 'JPY');
  if (pnlEl) {
    const sign = totalPnL >= 0 ? '+' : '';
    pnlEl.textContent = `${sign}${fmt(totalPnL, 'JPY')} (${sign}${totalPnLPct.toFixed(2)}%)`;
    pnlEl.style.color = totalPnL >= 0 ? 'var(--bullish)' : 'var(--bearish)';
  }

  if (!pfRecList) return;
  pfRecList.innerHTML = '';

  simResults.forEach(({ item, elapsed, currPrincipal, displayValue, dayChgPct, dayChgAmt,
                         annualReturn, simYears, totalMonths, finalPrincipal, finalValue,
                         principal, value }, rowIdx) => {

    const pnl       = displayValue - currPrincipal;
    const pnlPct    = currPrincipal > 0 ? (pnl / currPrincipal) * 100 : 0;
    const isUncounted = elapsed === 0; // 未来開始

    // 開始まであと何ヶ月
    const [sy, sm] = item.startMonth.split('-').map(Number);
    const now = new Date();
    const futureMonths = isUncounted
      ? (sy - now.getFullYear()) * 12 + (sm - (now.getMonth() + 1))
      : 0;

    const useLabel   = item.userAnnualReturn != null ? '手動' : '自動';
    const rateLabel  = `${(annualReturn * 100).toFixed(1)}%（${useLabel}）`;
    const pnlColor   = pnl >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    const pnlSign    = pnl >= 0 ? '+' : '';
    const daySign    = dayChgPct >= 0 ? '+' : '';
    const finalPnL   = finalValue - finalPrincipal;
    const finalPnLPct = finalPrincipal > 0 ? (finalPnL / finalPrincipal) * 100 : 0;

    const li = document.createElement('li');
    li.className = 'pf-row';
    li.style.setProperty('--i', rowIdx);
    li.dataset.symbol = item.symbol;

    const statusText = isUncounted
      ? `開始まであと${futureMonths}ヶ月`
      : `月${fmt(item.monthlyAmount, 'JPY')} × ${elapsed}ヶ月経過`;

    const canvasId = `rec-chart-${(item.id || item.symbol).replace(/[^a-z0-9]/gi, '')}-${rowIdx}`;

    li.innerHTML = `
      <button class="pf-row__main" type="button">
        <div class="pf-row__left">
          <div class="pf-row__symbol">${item.symbol}</div>
          <div class="pf-row__name">${statusText}</div>
        </div>
        <div class="pf-row__center">
          <div class="pf-row__value">${isUncounted ? '¥ 0' : fmt(displayValue, 'JPY')}</div>
          <div class="pf-row__qty">投入: ${fmt(currPrincipal, 'JPY')} ${isUncounted ? '' : pnlSign + fmt(pnl, 'JPY')}</div>
        </div>
        <div class="pf-row__right">
          <div class="pf-row__pnl-pct ${pnl >= 0 ? 'up' : 'down'}">${isUncounted ? '—' : fmtPct(pnlPct)}</div>
          <div class="pf-row__day-change" style="color:${dayChgPct >= 0 ? 'var(--bullish)' : 'var(--bearish)'}">
            ${isUncounted ? '—' : daySign + dayChgPct.toFixed(2) + '% 本日'}
          </div>
        </div>
      </button>
      <div class="pf-row__expand" hidden>
        <div class="pf-rec-detail">
          <div class="pf-rec-detail__row">
            <span>想定年利</span>
            <b style="color:var(--bullish)">${rateLabel}</b>
          </div>
          <div class="pf-rec-detail__row">
            <span>シミュレーション期間</span>
            <b>${simYears}年</b>
          </div>
          <div class="pf-rec-detail__row">
            <span>経過月数 / 総月数</span>
            <b>${elapsed} / ${totalMonths}ヶ月</b>
          </div>
          <div class="pf-rec-detail__row">
            <span>累計投入額（現在）</span>
            <b>${fmt(currPrincipal, 'JPY')}</b>
          </div>
          <div class="pf-rec-detail__row">
            <span>予測評価額（現在）</span>
            <b style="color:var(--bullish)">${isUncounted ? '¥ 0' : fmt(displayValue, 'JPY')}</b>
          </div>
          <div class="pf-rec-detail__row">
            <span>本日の変動</span>
            <b style="color:${dayChgPct >= 0 ? 'var(--bullish)' : 'var(--bearish)'}">
              ${daySign}${dayChgPct.toFixed(2)}% (${daySign}${fmt(dayChgAmt, 'JPY')})
            </b>
          </div>
          <div class="pf-rec-detail__row">
            <span>損益（現在）</span>
            <b style="color:${pnlColor}">${isUncounted ? '—' : pnlSign + fmt(pnl, 'JPY') + ' (' + fmtPct(pnlPct) + ')'}</b>
          </div>
          <div class="pf-rec-detail__future">
            <div class="pf-rec-detail__future-title">${simYears}年後の予測</div>
            <div class="pf-rec-detail__row"><span>投入合計</span><b>${fmt(finalPrincipal, 'JPY')}</b></div>
            <div class="pf-rec-detail__row">
              <span>評価額</span>
              <b style="color:var(--bullish)">約${fmt(finalValue, 'JPY')}</b>
            </div>
            <div class="pf-rec-detail__row">
              <span>損益</span>
              <b style="color:var(--bullish)">+${fmt(finalPnL, 'JPY')} (+${finalPnLPct.toFixed(0)}%)</b>
            </div>
          </div>
          <div class="pf-rec-chart-wrapper">
            <div class="pf-rec-chart-summary">
              <span>期間 <strong>${simYears}年</strong></span>
              <span>年利 <strong>${(annualReturn * 100).toFixed(1)}%</strong></span>
              <span>最終評価額 <strong>¥${formatYAxisJPY(finalValue)}</strong></span>
            </div>
            <canvas id="${canvasId}" class="pf-rec-chart"></canvas>
          </div>
        </div>
        <div class="pf-row__actions">
          <button class="pf-btn-ghost pf-rec-edit" type="button">✏ 編集</button>
          <button class="pf-btn-ghost pf-rec-rate" type="button">📈 年利を変更</button>
          <button class="pf-btn-danger pf-rec-delete" type="button">🗑 削除</button>
        </div>
      </div>
    `;

    li.querySelector('.pf-row__main').addEventListener('click', () => {
      const expand = li.querySelector('.pf-row__expand');
      const wasHidden = expand.hidden;
      expand.hidden = !wasHidden;
      if (wasHidden) {
        // グラフ描画（1フレーム後）
        requestAnimationFrame(() => {
          const canvas = document.getElementById(canvasId);
          if (canvas && !canvas.dataset.drawn) {
            canvas.dataset.drawn = '1';
            renderRecurringChart(canvas, item, elapsed);
          }
        });
      }
    });

    li.querySelector('.pf-rec-edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditRecurringModal(item);
    });

    li.querySelector('.pf-rec-rate').addEventListener('click', e => {
      e.stopPropagation();
      openAnnualReturnModal(item);
    });

    li.querySelector('.pf-rec-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteRecurring(item.id || item.symbol);
    });

    pfRecList.appendChild(li);
  });
}

// ─── ヒーロースパークライン ──────────────────────────────
async function loadHeroSparkline(period) {
  const items = loadPortfolio();
  if (!items.length) return;

  const rangeMap = {
    '1D':  ['1d',  '5m'],
    '1W':  ['5d',  '1h'],
    '1M':  ['1mo', '1d'],
    '3M':  ['3mo', '1d'],
    '1Y':  ['1y',  '1wk'],
    'ALL': ['max', '1mo'],
  };
  const [range, interval] = rangeMap[period] || ['1mo', '1d'];
  const hist = await fetchHistory(items[0].symbol, range, interval);
  if (hist) {
    const firstPrice = hist[0]?.c || 0;
    const lastPrice  = hist[hist.length - 1]?.c || 0;
    renderSparkline('pfSparkline', hist, lastPrice >= firstPrice ? '#00c853' : '#ff3b30');
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
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  });

  const holdingsSection  = document.getElementById('pfHoldingsSection');
  const recurringSection = document.getElementById('pfRecurringSection');
  if (holdingsSection)  holdingsSection.hidden  = mode !== 'holdings';
  if (recurringSection) recurringSection.hidden = mode !== 'recurring';

  const fab = document.getElementById('pfAddBtn');
  if (fab) {
    fab.dataset.mode = mode;
    fab.setAttribute('aria-label', mode === 'recurring' ? '積立を追加' : '銘柄を追加');
  }

  localStorage.setItem('pf_current_mode', mode);
  render();
}

// ─── Monte Carlo UI 統合 ──────────────────────────────────
let _mcResult = null;
let _mcRunning = false;

function initMonteCarlo() {
  const section = document.getElementById('mcSection');
  if (!section) return;

  // 実行ボタン
  document.getElementById('mcRunBtn')?.addEventListener('click', runMonteCarlo);

  // 確率密度タブ
  document.getElementById('mcDensityTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.mc-density-tab');
    if (!tab) return;
    document.querySelectorAll('.mc-density-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    if (_mcResult && _mcResult.distributions) {
      DensityViewer.setTab(tab.dataset.tab);
    }
  });

  // 目標額変更時
  document.getElementById('mcTargetInput')?.addEventListener('change', () => {
    if (_mcResult) {
      updateMcKpiGoal(_mcResult);
      // ファンチャート再描画
      const items = loadRecurring();
      const selIdx = document.getElementById('mcItemSelect')?.selectedIndex || 0;
      const item = items[selIdx];
      if (item) {
        const targetAmount = parseFloat(document.getElementById('mcTargetInput')?.value) || 100000000;
        FanChart.render('mcFanChart', _mcResult, {
          targetAmount,
          startYear: parseInt(item.startMonth?.split('-')[0]) || new Date().getFullYear(),
          simYears: item.simYears || 30,
          animate: false,
        });
        // 密度ビューア更新
        if (_mcResult.distributions) {
          DensityViewer.setTarget(targetAmount);
        }
      }
    }
  });
}

function updateMcItemSelector() {
  const select = document.getElementById('mcItemSelect');
  const section = document.getElementById('mcSection');
  if (!select || !section) return;

  const items = loadRecurring();
  select.innerHTML = '';

  if (items.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  items.forEach((item, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${item.symbol} - 月${MonteCarloEngine.formatJPYCompact(item.monthlyAmount)} × ${item.simYears || 30}年`;
    select.appendChild(opt);
  });
}

async function runMonteCarlo() {
  if (_mcRunning) return;
  _mcRunning = true;

  const items = loadRecurring();
  const selIdx = parseInt(document.getElementById('mcItemSelect')?.value) || 0;
  const item = items[selIdx];
  if (!item) {
    _mcRunning = false;
    return;
  }

  const targetAmount = parseFloat(document.getElementById('mcTargetInput')?.value) || 100000000;
  const numTrials = parseInt(document.getElementById('mcTrialsSelect')?.value) || 10000;
  const mode = document.getElementById('mcModeSelect')?.value || 'bootstrap';

  // UIステート
  const runBtn = document.getElementById('mcRunBtn');
  const progress = document.getElementById('mcProgress');
  const progressBar = document.getElementById('mcProgressBar');
  const progressText = document.getElementById('mcProgressText');

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '計算中...'; }
  if (progress) { progress.classList.add('active'); }
  if (progressText) { progressText.hidden = false; }
  if (progressBar) { progressBar.style.width = '0%'; }

  // KPI/Chart を隠す
  ['mcKpiGrid', 'mcFanChartWrapper', 'mcLegend', 'mcDensitySection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });

  try {
    const result = await MonteCarloEngine.runSimulation({
      symbol: item.symbol,
      monthlyAmount: item.monthlyAmount,
      simYears: item.simYears || 30,
      targetAmount,
      numTrials,
      mode,
      seed: 42,
      onProgress: (data) => {
        if (progressBar) progressBar.style.width = data.pct + '%';
        if (progressText) progressText.textContent = `${data.completed.toLocaleString()} / ${data.total.toLocaleString()} 試行完了`;
      },
    });

    _mcResult = result;

    // UI更新
    if (progress) progress.classList.remove('active');
    if (progressText) progressText.hidden = true;

    // KPIカード更新
    updateMcKpi(result, item, targetAmount);

    // ファンチャート描画
    const startYear = parseInt(item.startMonth?.split('-')[0]) || new Date().getFullYear();
    document.getElementById('mcFanChartWrapper').hidden = false;
    document.getElementById('mcLegend').hidden = false;
    FanChart.render('mcFanChart', result, {
      targetAmount,
      startYear,
      simYears: item.simYears || 30,
      animate: true,
    });

    // 確率密度ビューア
    if (result.distributions && Object.keys(result.distributions).length > 0) {
      document.getElementById('mcDensitySection').hidden = false;
      // タブの有効/無効を調整
      const tabs = document.querySelectorAll('.mc-density-tab');
      tabs.forEach(tab => {
        const key = tab.dataset.tab;
        tab.disabled = !result.distributions[key];
        tab.style.opacity = result.distributions[key] ? '1' : '0.3';
      });
      // アクティブタブのデータを描画
      const activeTab = document.querySelector('.mc-density-tab.active')?.dataset.tab || 'final';
      DensityViewer.render('mcDensityChart', result.distributions, {
        targetAmount,
        activeTab,
        onTargetChange: (newTarget) => {
          const input = document.getElementById('mcTargetInput');
          if (input) input.value = Math.round(newTarget);
          updateMcKpiGoal(result);
        },
      });
    }

  } catch (err) {
    console.error('[MC] Simulation error:', err);
    if (progressText) {
      progressText.textContent = 'エラー: ' + (err.message || 'シミュレーションに失敗しました');
      progressText.hidden = false;
    }
  } finally {
    _mcRunning = false;
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'シミュレーション実行'; }
    if (progress) progress.classList.remove('active');
  }
}

function updateMcKpi(result, item, targetAmount) {
  const stats = result.stats;
  const grid = document.getElementById('mcKpiGrid');
  if (!grid) return;
  grid.hidden = false;

  // Card 1: 目標達成確率
  const prob = stats.goalProbability;
  const probPct = (prob * 100).toFixed(1);
  let probLevel = 'low';
  if (prob >= 0.85) probLevel = 'very-high';
  else if (prob >= 0.60) probLevel = 'high';
  else if (prob >= 0.30) probLevel = 'medium';

  const goalCard = document.getElementById('mcKpiGoal');
  if (goalCard) goalCard.dataset.probLevel = probLevel;

  const ring = document.getElementById('mcRingFg');
  if (ring) {
    const circumference = 2 * Math.PI * 15.9;
    ring.setAttribute('stroke-dasharray', `${circumference} ${circumference}`);
    // animate ring
    ring.setAttribute('stroke-dashoffset', circumference);
    requestAnimationFrame(() => {
      ring.style.transition = 'stroke-dashoffset 1200ms cubic-bezier(0.16, 1, 0.3, 1)';
      ring.setAttribute('stroke-dashoffset', circumference * (1 - prob));
    });
  }

  animateCountUp('mcGoalPct', 0, parseFloat(probPct), 1200, (v) => v.toFixed(1) + '%');
  const goalSub = document.getElementById('mcGoalSub');
  if (goalSub) {
    goalSub.innerHTML = `${stats.years}年後に ${MonteCarloEngine.formatJPY(targetAmount)} 達成`;
  }

  // Card 2: 中央値
  animateCountUp('mcMedianVal', 0, stats.medianFinal, 1200, MonteCarloEngine.formatJPY);
  const medianSub = document.getElementById('mcMedianSub');
  if (medianSub) {
    medianSub.innerHTML = `年率換算 <b>${stats.medianIRR >= 0 ? '+' : ''}${(stats.medianIRR * 100).toFixed(1)}%</b><br>元本の <b>${stats.medianMultiple.toFixed(2)}倍</b>`;
  }

  // Card 3: 最悪ケース
  animateCountUp('mcWorstVal', 0, stats.p5Final, 1200, MonteCarloEngine.formatJPY);
  const worstSub = document.getElementById('mcWorstSub');
  if (worstSub) {
    worstSub.innerHTML = `最大DD <b>-${(stats.maxDrawdown5 * 100).toFixed(0)}%</b><br>5%の確率でこれ以下`;
  }

  // Card 4: 最良ケース
  animateCountUp('mcBestVal', 0, stats.p95Final, 1200, MonteCarloEngine.formatJPY);
  const bestSub = document.getElementById('mcBestSub');
  if (bestSub) {
    bestSub.innerHTML = `年率換算 <b>${stats.p95IRR >= 0 ? '+' : ''}${(stats.p95IRR * 100).toFixed(1)}%</b><br>5%の確率でこれ以上`;
  }
}

function updateMcKpiGoal(result) {
  const targetAmount = parseFloat(document.getElementById('mcTargetInput')?.value) || 100000000;
  const dist = result.distributions?.final;
  if (!dist) return;

  const prob = MonteCarloEngine.calcGoalProbability(dist, targetAmount);
  const probPct = (prob * 100).toFixed(1);

  let probLevel = 'low';
  if (prob >= 0.85) probLevel = 'very-high';
  else if (prob >= 0.60) probLevel = 'high';
  else if (prob >= 0.30) probLevel = 'medium';

  const goalCard = document.getElementById('mcKpiGoal');
  if (goalCard) goalCard.dataset.probLevel = probLevel;

  const pctEl = document.getElementById('mcGoalPct');
  if (pctEl) pctEl.textContent = probPct + '%';

  const ring = document.getElementById('mcRingFg');
  if (ring) {
    const circumference = 2 * Math.PI * 15.9;
    ring.setAttribute('stroke-dashoffset', circumference * (1 - prob));
  }

  const goalSub = document.getElementById('mcGoalSub');
  if (goalSub) {
    goalSub.innerHTML = `${result.stats.years}年後に ${MonteCarloEngine.formatJPY(targetAmount)} 達成`;
  }
}

function animateCountUp(elementId, start, end, duration, formatter) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    el.textContent = formatter(end);
    return;
  }

  const startTime = performance.now();
  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // cubic-bezier(0.16, 1, 0.3, 1) approximation
    const t = 1 - Math.pow(1 - progress, 3);
    const current = start + (end - start) * t;
    el.textContent = formatter(current);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ─── 初期化 ───────────────────────────────────────────────
function initPortfolio() {
  // モードタブ
  document.querySelectorAll('.pf-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // FABボタン（モードに応じて専用モーダルを開く）
  document.getElementById('pfAddBtn')?.addEventListener('click', () => {
    if (_currentMode === 'recurring') {
      openRecurringModal();
    } else {
      openHoldingsModal();
    }
  });

  // バックドロップ・キャンセルボタンで閉じる
  document.addEventListener('click', function(e) {
    const closeTrigger = e.target.closest('[data-close]');
    if (!closeTrigger) return;

    console.log('[pf] close trigger clicked:', closeTrigger.tagName, closeTrigger.className);

    e.preventDefault();
    e.stopPropagation();

    // モーダル要素を確実に取得（複数の方法でフォールバック）
    let modalEl = closeTrigger.closest('.pf-modal');
    if (!modalEl) {
      modalEl = closeTrigger.classList.contains('pf-modal')
        ? closeTrigger
        : document.querySelector('.pf-modal:not([hidden])');
    }

    console.log('[pf] modal element found:', modalEl ? modalEl.id : 'NULL');

    if (modalEl) {
      hideModal(modalEl);
    } else {
      // 最終手段: 全モーダル強制クローズ
      console.warn('[pf] fallback: closing all modals');
      document.querySelectorAll('.pf-modal').forEach(m => {
        m.hidden = true;
      });
      document.body.style.overflow = '';
      document.body.style.position = '';
    }
  });

  // Holdings モーダル
  document.getElementById('pfSaveHoldingsBtn')?.addEventListener('click', onSaveHoldings);
  document.getElementById('pfModalHoldings')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveHoldings(); }
  });
  document.getElementById('pfHTickerInput')?.addEventListener('input', onHTickerInput);

  // Recurring モーダル
  document.getElementById('pfSaveRecurringBtn')?.addEventListener('click', onSaveRecurring);
  document.getElementById('pfModalRecurring')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveRecurring(); }
  });
  document.getElementById('pfRTickerInput')?.addEventListener('input', onRTickerInput);

  // 年利変更モーダル
  document.getElementById('pfSaveARBtn')?.addEventListener('click', onSaveAnnualReturn);
  document.getElementById('pfARReset')?.addEventListener('change', e => {
    const input = document.getElementById('pfARInput');
    if (input) input.disabled = e.target.checked;
  });

  // プリセットチップ
  document.querySelectorAll('.pf-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('pfRTickerInput').value = btn.dataset.symbol;
      document.querySelectorAll('.pf-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('pfRAmountInput').focus();
    });
  });

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

  // モード復元
  const savedMode = localStorage.getItem('pf_current_mode') || 'holdings';
  switchMode(savedMode);

  // 初回レンダリング（switchMode 内で render() 済みだがスパークラインは別途）
  loadHeroSparkline('1M');
  updateLastRefreshTime();

  // Monte Carlo 初期化
  initMonteCarlo();

  // 自動更新 (30秒)
  startAutoRefresh(30000);
}

document.addEventListener('DOMContentLoaded', initPortfolio);
