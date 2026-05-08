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

// ─── Recurring モーダル ───────────────────────────────────
function openRecurringModal() {
  const modal = document.getElementById('pfModalRecurring');
  if (!modal) return;
  modal.dataset.editingId = '';

  // デフォルト開始月: 12ヶ月前
  const d = new Date();
  d.setMonth(d.getMonth() - 12);
  document.getElementById('pfRStartInput').value =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  showModal(modal);
}

function openEditRecurringModal(item) {
  const modal = document.getElementById('pfModalRecurring');
  if (!modal) return;
  modal.dataset.editingId = item.symbol;

  document.getElementById('pfRTickerInput').value = item.symbol;
  document.getElementById('pfRTickerInput').disabled = true;
  document.getElementById('pfRAmountInput').value = item.monthlyAmount;
  document.getElementById('pfRStartInput').value  = item.startMonth;

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

  const tickerEl = document.getElementById('pfRTickerInput');
  const amountEl = document.getElementById('pfRAmountInput');
  const startEl  = document.getElementById('pfRStartInput');

  const ticker        = tickerEl.value.trim();
  const monthlyAmount = parseFloat(amountEl.value);
  const startMonth    = startEl.value;

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

  const startDate = new Date(startMonth + '-01');
  const now = new Date();
  if (startDate > now) {
    showToast('開始月は今月以前を選択してください', 'error');
    return;
  }
  if (startDate < new Date('1990-01-01')) {
    showToast('開始月は1990年以降を選択してください', 'error');
    return;
  }

  const saveBtn = document.getElementById('pfSaveRecurringBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '確認中…';

  try {
    const validation = await validateSymbol(ticker);
    let finalSymbol = validation.symbol;

    if (!validation.ok) {
      const proceed = confirm(
        `「${validation.tried.join('」「')}」の価格データが取得できませんでした。それでも登録しますか？`
      );
      if (!proceed) return;
    }

    const items = loadRecurring();
    const existing = items.findIndex(i => i.symbol === finalSymbol);
    const newItem = {
      symbol: finalSymbol,
      monthlyAmount,
      startMonth,
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

function deleteRecurring(symbol) {
  const items = loadRecurring().filter(i => i.symbol !== symbol);
  saveRecurring(items);
  renderRecurring();
}

// ─── 積立計算ロジック ─────────────────────────────────────
async function computeRecurring(item) {
  const start = new Date(item.startMonth + '-01');
  const now   = new Date();
  const monthsElapsed =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth()) + 1;

  const range     = monthsElapsed > 60 ? '10y' : '5y';
  const yahooUrl  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=${range}&interval=1mo`;
  const proxyUrl  = `${WORKER_BASE}/?url=${encodeURIComponent(yahooUrl)}`;

  try {
    const res    = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json   = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result)  return null;

    const timestamps   = result.timestamp || [];
    const opens        = result.indicators?.quote?.[0]?.open || [];
    const currentPrice = result.meta.regularMarketPrice;
    const currency     = result.meta.currency || 'USD';

    let totalShares   = 0;
    let totalInvested = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const date = new Date(timestamps[i] * 1000);
      if (date < start) continue;
      if (date > now)   break;
      const price = opens[i];
      if (!price) continue;
      totalShares   += item.monthlyAmount / price;
      totalInvested += item.monthlyAmount;
    }

    const currentValue = totalShares * currentPrice;
    const pnl          = currentValue - totalInvested;
    const pnlPct       = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
    const years        = monthsElapsed / 12;
    const cagr         =
      totalInvested > 0 && years > 0
        ? (Math.pow(currentValue / totalInvested, 1 / years) - 1) * 100
        : 0;

    return { totalShares, totalInvested, currentValue, currentPrice, pnl, pnlPct, monthsElapsed, cagr, currency };
  } catch (e) {
    console.warn(`computeRecurring(${item.symbol}) failed:`, e);
    return null;
  }
}

// ─── Recurring レンダリング ──────────────────────────────
async function renderRecurring() {
  const items      = loadRecurring();
  const pfRecList  = document.getElementById('pfRecList');
  const pfRecEmpty = document.getElementById('pfRecEmpty');

  if (!items.length) {
    if (pfRecEmpty) pfRecEmpty.hidden = false;
    if (pfRecList)  pfRecList.innerHTML = '';
    const inv = document.getElementById('pfRecInvested');
    const cur = document.getElementById('pfRecCurrent');
    const pnl = document.getElementById('pfRecPnL');
    if (inv) inv.textContent = '¥ 0';
    if (cur) cur.textContent = '¥ 0';
    if (pnl) pnl.textContent = '¥ 0 (+0.00%)';
    return;
  }

  if (pfRecEmpty) pfRecEmpty.hidden = true;
  if (pfRecList)  pfRecList.innerHTML =
    '<li style="padding:16px;color:var(--text-muted);text-align:center;font-size:13px;">計算中...</li>';

  const results = await Promise.all(items.map(item => computeRecurring(item)));

  let totalInvested = 0;
  let totalCurrent  = 0;
  results.forEach(r => {
    if (r) { totalInvested += r.totalInvested; totalCurrent += r.currentValue; }
  });

  const totalPnL    = totalCurrent - totalInvested;
  const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

  const invEl = document.getElementById('pfRecInvested');
  const curEl = document.getElementById('pfRecCurrent');
  const pnlEl = document.getElementById('pfRecPnL');
  if (invEl) invEl.textContent = fmt(totalInvested, 'JPY');
  if (curEl) curEl.textContent = fmt(totalCurrent,  'JPY');
  if (pnlEl) {
    pnlEl.textContent = `${totalPnL >= 0 ? '+' : ''}${fmt(totalPnL, 'JPY')} (${fmtPct(totalPnLPct)})`;
    pnlEl.style.color = totalPnL >= 0 ? 'var(--bullish)' : 'var(--bearish)';
  }

  if (!pfRecList) return;
  pfRecList.innerHTML = '';

  items.forEach((item, idx) => {
    const r        = results[idx];
    const pnlColor = r && r.pnl >= 0 ? 'var(--bullish)' : 'var(--bearish)';
    const pnlSign  = r && r.pnl >= 0 ? '+' : '';
    const avgCost  = r && r.totalShares > 0 ? r.totalInvested / r.totalShares : null;

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

  // 自動更新 (30秒)
  startAutoRefresh(30000);
}

document.addEventListener('DOMContentLoaded', initPortfolio);
