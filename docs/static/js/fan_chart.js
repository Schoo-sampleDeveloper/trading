/**
 * Fan Chart - D3.js v7 ファンチャート
 * 確率分布帯をグラデーション表示し、ホバーでクロスヘア+ツールチップ。
 */
'use strict';

const FanChart = (function () {
  const COLORS = {
    band1: { fill: 'rgba(0, 217, 255, 0.06)', stroke: 'none' },   // p5-p95
    band2: { fill: 'rgba(0, 217, 255, 0.10)', stroke: 'none' },   // p10-p90
    band3: { fill: 'rgba(0, 217, 255, 0.16)', stroke: 'none' },   // p25-p75
    median: '#00FF88',
    principal: 'rgba(255, 255, 255, 0.5)',
    goal: '#FFD60A',
    crosshair: 'rgba(255, 255, 255, 0.3)',
  };

  const LIGHT_COLORS = {
    band1: { fill: 'rgba(0, 150, 200, 0.08)', stroke: 'none' },
    band2: { fill: 'rgba(0, 150, 200, 0.14)', stroke: 'none' },
    band3: { fill: 'rgba(0, 150, 200, 0.22)', stroke: 'none' },
    median: '#059669',
    principal: 'rgba(0, 0, 0, 0.35)',
    goal: '#B8860B',
    crosshair: 'rgba(0, 0, 0, 0.2)',
  };

  let _svg = null;
  let _data = null;
  let _targetAmount = 0;
  let _container = null;
  let _tooltip = null;
  let _onHover = null;
  let _resizeObserver = null;

  function getColors() {
    const theme = document.body.dataset.theme;
    return theme === 'light' ? LIGHT_COLORS : COLORS;
  }

  function formatAxisJPY(value) {
    if (value >= 1e12) return `${(value / 1e12).toFixed(1)}兆`;
    if (value >= 1e8) return `${(value / 1e8).toFixed(1)}億`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(0)}万`;
    if (value === 0) return '0';
    return Math.round(value).toLocaleString();
  }

  function render(containerId, simResult, options = {}) {
    const {
      targetAmount = 0,
      startYear = new Date().getFullYear(),
      simYears = 30,
      onHover = null,
      animate = true,
    } = options;

    _targetAmount = targetAmount;
    _onHover = onHover;
    _data = simResult;
    _container = document.getElementById(containerId);
    if (!_container) return;

    // クリア
    _container.innerHTML = '';

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldAnimate = animate && !reducedMotion;
    const colors = getColors();
    const rect = _container.getBoundingClientRect();
    const width = rect.width || 800;
    const height = Math.min(rect.height || 480, 480);
    const margin = { top: 20, right: 60, bottom: 40, left: 70 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    // SVG 作成
    const svg = d3
      .select(`#${containerId}`)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('role', 'img')
      .attr('aria-label', 'モンテカルロ・ファンチャート: 積立投資の確率的予測')
      .style('overflow', 'visible');
    _svg = svg;

    // defs: グロー効果
    const defs = svg.append('defs');
    const glowFilter = defs.append('filter').attr('id', 'mc-glow');
    glowFilter
      .append('feGaussianBlur')
      .attr('stdDeviation', '3')
      .attr('result', 'blur');
    const feMerge = glowFilter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'blur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // グラデーション (ファンの背景)
    const bandGrad = defs
      .append('linearGradient')
      .attr('id', 'mc-band-grad')
      .attr('x1', '0%').attr('y1', '0%')
      .attr('x2', '100%').attr('y2', '0%');
    bandGrad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(0,217,255,0.0)');
    bandGrad.append('stop').attr('offset', '10%').attr('stop-color', 'rgba(0,217,255,1)');
    bandGrad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(255,61,142,1)');

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // データ準備 (月次→年次に集約)
    const percentiles = simResult.percentiles;
    const principal = simResult.principal;
    const numMonths = principal.length;

    // 年次データポイント生成
    const yearlyData = [];
    for (let y = 0; y <= simYears; y++) {
      const m = y === 0 ? 0 : y * 12 - 1;
      const idx = Math.min(m, numMonths - 1);
      yearlyData.push({
        year: y,
        label: startYear + y,
        p5: y === 0 ? 0 : percentiles.p5[idx],
        p10: y === 0 ? 0 : percentiles.p10[idx],
        p25: y === 0 ? 0 : percentiles.p25[idx],
        p50: y === 0 ? 0 : percentiles.p50[idx],
        p75: y === 0 ? 0 : percentiles.p75[idx],
        p90: y === 0 ? 0 : percentiles.p90[idx],
        p95: y === 0 ? 0 : percentiles.p95[idx],
        principal: y === 0 ? 0 : principal[idx],
      });
    }

    // スケール
    const maxVal = d3.max(yearlyData, (d) => d.p95) || 1;
    const yMax = maxVal * 1.1;

    const x = d3.scaleLinear().domain([0, simYears]).range([0, innerW]);
    const y = d3.scaleLinear().domain([0, yMax]).range([innerH, 0]).nice();

    // X軸
    const xTickCount = innerW > 600 ? simYears : Math.min(simYears, 10);
    const xAxis = d3.axisBottom(x)
      .ticks(xTickCount)
      .tickFormat((d) => d === 0 ? '開始' : `${d}年`);

    g.append('g')
      .attr('class', 'mc-axis mc-axis--x')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .selectAll('text')
      .attr('fill', 'var(--text-secondary, #8B92A5)')
      .attr('font-size', '11px');

    // Y軸
    const yAxis = d3.axisLeft(y)
      .ticks(6)
      .tickFormat(formatAxisJPY);

    g.append('g')
      .attr('class', 'mc-axis mc-axis--y')
      .call(yAxis)
      .selectAll('text')
      .attr('fill', 'var(--text-secondary, #8B92A5)')
      .attr('font-size', '11px');

    // グリッド線
    g.append('g')
      .attr('class', 'mc-grid')
      .selectAll('line')
      .data(y.ticks(6))
      .join('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', (d) => y(d)).attr('y2', (d) => y(d))
      .attr('stroke', 'var(--border-subtle, rgba(255,255,255,0.06))')
      .attr('stroke-dasharray', '2,4');

    // ─── 確率帯 (Area) ──────────────────────────────────
    const area = (upper, lower) =>
      d3.area()
        .x((d) => x(d.year))
        .y0((d) => y(d[lower]))
        .y1((d) => y(d[upper]))
        .curve(d3.curveMonotoneX);

    // バンド描画 (外側→内側)
    const bands = [
      { upper: 'p95', lower: 'p5', color: colors.band1 },
      { upper: 'p90', lower: 'p10', color: colors.band2 },
      { upper: 'p75', lower: 'p25', color: colors.band3 },
    ];

    const bandGroup = g.append('g').attr('class', 'mc-bands');

    bands.forEach((band, i) => {
      const path = bandGroup
        .append('path')
        .datum(yearlyData)
        .attr('d', area(band.upper, band.lower))
        .attr('fill', band.color.fill)
        .attr('stroke', 'none');

      if (shouldAnimate) {
        path
          .attr('opacity', 0)
          .transition()
          .duration(800)
          .delay(600 + i * 200)
          .attr('opacity', 1);
      }
    });

    // ─── 元本ライン ─────────────────────────────────────
    const principalLine = d3.line()
      .x((d) => x(d.year))
      .y((d) => y(d.principal))
      .curve(d3.curveMonotoneX);

    const principalPath = g
      .append('path')
      .datum(yearlyData)
      .attr('d', principalLine)
      .attr('fill', 'none')
      .attr('stroke', colors.principal)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '6,4');

    // ─── 中央値ライン ────────────────────────────────────
    const medianLine = d3.line()
      .x((d) => x(d.year))
      .y((d) => y(d.p50))
      .curve(d3.curveMonotoneX);

    const medianPath = g
      .append('path')
      .datum(yearlyData)
      .attr('d', medianLine)
      .attr('fill', 'none')
      .attr('stroke', colors.median)
      .attr('stroke-width', 2.5)
      .attr('filter', 'url(#mc-glow)');

    // 中央値アニメーション (左→右 reveal)
    if (shouldAnimate) {
      const totalLength = medianPath.node().getTotalLength();
      medianPath
        .attr('stroke-dasharray', totalLength)
        .attr('stroke-dashoffset', totalLength)
        .transition()
        .duration(1500)
        .ease(d3.easeCubicOut)
        .attr('stroke-dashoffset', 0);

      // 元本ラインも同様
      const pLen = principalPath.node().getTotalLength();
      principalPath
        .attr('stroke-dasharray', pLen)
        .attr('stroke-dashoffset', pLen)
        .transition()
        .duration(1500)
        .ease(d3.easeCubicOut)
        .attr('stroke-dashoffset', 0);
    }

    // ─── 目標額ライン ────────────────────────────────────
    if (targetAmount > 0 && targetAmount < yMax) {
      const goalY = y(targetAmount);
      g.append('line')
        .attr('class', 'mc-goal-line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', goalY).attr('y2', goalY)
        .attr('stroke', colors.goal)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '8,4')
        .attr('opacity', 0.8);

      g.append('text')
        .attr('x', innerW - 4)
        .attr('y', goalY - 8)
        .attr('text-anchor', 'end')
        .attr('fill', colors.goal)
        .attr('font-size', '11px')
        .attr('font-weight', '600')
        .text(`目標 ${MonteCarloEngine.formatJPYCompact(targetAmount)}`);
    }

    // ─── ホバー・インタラクション ─────────────────────────
    // クロスヘア要素
    const crosshair = g.append('g').attr('class', 'mc-crosshair').style('display', 'none');

    crosshair
      .append('line')
      .attr('class', 'mc-crosshair__v')
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', colors.crosshair)
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,3');

    // ホバードット
    const hoverDots = crosshair.append('g');
    hoverDots.append('circle').attr('class', 'mc-dot-median').attr('r', 5)
      .attr('fill', colors.median).attr('stroke', '#fff').attr('stroke-width', 1.5);
    hoverDots.append('circle').attr('class', 'mc-dot-principal').attr('r', 3.5)
      .attr('fill', colors.principal);

    // ツールチップ
    if (!_tooltip) {
      _tooltip = d3
        .select('body')
        .append('div')
        .attr('class', 'mc-tooltip')
        .style('display', 'none');
    }

    // ホバー領域
    const overlay = g
      .append('rect')
      .attr('class', 'mc-overlay')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair');

    const bisect = d3.bisector((d) => d.year).left;

    overlay.on('mousemove touchmove', function (event) {
      event.preventDefault();
      const [mx] = d3.pointer(event, this);
      const yearVal = x.invert(mx);
      const idx = bisect(yearlyData, yearVal, 1);
      const d0 = yearlyData[Math.max(0, idx - 1)];
      const d1 = yearlyData[Math.min(idx, yearlyData.length - 1)];
      const d = yearVal - d0.year > d1.year - yearVal ? d1 : d0;

      const cx = x(d.year);
      crosshair.style('display', null);
      crosshair.select('.mc-crosshair__v').attr('x1', cx).attr('x2', cx);
      crosshair.select('.mc-dot-median')
        .attr('cx', cx).attr('cy', y(d.p50));
      crosshair.select('.mc-dot-principal')
        .attr('cx', cx).attr('cy', y(d.principal));

      // ツールチップ内容
      const goalProb = targetAmount > 0
        ? calcGoalProbAtYear(simResult, d.year, targetAmount)
        : null;

      let html = `<div class="mc-tooltip__title">${d.year === 0 ? '開始時点' : d.year + '年後'} (${d.label}年)</div>`;
      html += `<div class="mc-tooltip__row"><span class="mc-tooltip__dot" style="background:${colors.median}"></span>中央値: <b>${MonteCarloEngine.formatJPY(d.p50)}</b></div>`;
      html += `<div class="mc-tooltip__row"><span class="mc-tooltip__dot" style="background:${colors.principal}"></span>元本: <b>${MonteCarloEngine.formatJPY(d.principal)}</b></div>`;
      html += `<div class="mc-tooltip__row mc-tooltip__range">5-95%: ${MonteCarloEngine.formatJPY(d.p5)} 〜 ${MonteCarloEngine.formatJPY(d.p95)}</div>`;
      if (goalProb !== null) {
        html += `<div class="mc-tooltip__row mc-tooltip__goal">目標達成確率: <b>${(goalProb * 100).toFixed(1)}%</b></div>`;
      }

      _tooltip
        .html(html)
        .style('display', 'block');

      // ツールチップ位置
      const tooltipNode = _tooltip.node();
      const ttW = tooltipNode.offsetWidth;
      const ttH = tooltipNode.offsetHeight;
      const pageX = event.pageX || (event.touches && event.touches[0].pageX) || 0;
      const pageY = event.pageY || (event.touches && event.touches[0].pageY) || 0;
      const flipX = pageX + ttW + 20 > window.innerWidth;
      _tooltip
        .style('left', (flipX ? pageX - ttW - 10 : pageX + 15) + 'px')
        .style('top', (pageY - ttH / 2) + 'px');

      // コールバック
      if (_onHover) _onHover(d);
    });

    overlay.on('mouseleave touchend', function () {
      crosshair.style('display', 'none');
      if (_tooltip) _tooltip.style('display', 'none');
    });

    // ─── 軸スタイル ─────────────────────────────────────
    svg.selectAll('.mc-axis path, .mc-axis line')
      .attr('stroke', 'var(--border-subtle, rgba(255,255,255,0.1))');

    // レスポンシブ
    setupResize(containerId, simResult, options);
  }

  function calcGoalProbAtYear(simResult, year, target) {
    if (year <= 0) return 0;
    const monthIdx = year * 12 - 1;
    const p = simResult.percentiles;
    if (!p || !p.p5) return null;
    const numMonths = p.p5.length;
    const idx = Math.min(monthIdx, numMonths - 1);

    // パーセンタイルから補間で近似
    const pcts = [
      { p: 0.05, v: p.p5[idx] },
      { p: 0.10, v: p.p10[idx] },
      { p: 0.25, v: p.p25[idx] },
      { p: 0.50, v: p.p50[idx] },
      { p: 0.75, v: p.p75[idx] },
      { p: 0.90, v: p.p90[idx] },
      { p: 0.95, v: p.p95[idx] },
    ];

    if (target <= pcts[0].v) return 0.97;
    if (target >= pcts[pcts.length - 1].v) return 0.03;

    for (let i = 0; i < pcts.length - 1; i++) {
      if (target >= pcts[i].v && target <= pcts[i + 1].v) {
        const frac =
          (target - pcts[i].v) / (pcts[i + 1].v - pcts[i].v);
        const prob = 1 - (pcts[i].p + frac * (pcts[i + 1].p - pcts[i].p));
        return prob;
      }
    }
    return 0.5;
  }

  function setupResize(containerId, simResult, options) {
    if (_resizeObserver) _resizeObserver.disconnect();
    const el = document.getElementById(containerId);
    if (!el) return;

    let resizeTimeout;
    _resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        render(containerId, simResult, { ...options, animate: false });
      }, 200);
    });
    _resizeObserver.observe(el);
  }

  function updateTarget(newTarget) {
    _targetAmount = newTarget;
    // 目標ラインの再描画はfull re-renderで対応
  }

  function destroy() {
    if (_resizeObserver) {
      _resizeObserver.disconnect();
      _resizeObserver = null;
    }
    if (_tooltip) {
      _tooltip.remove();
      _tooltip = null;
    }
    if (_container) {
      _container.innerHTML = '';
    }
    _svg = null;
    _data = null;
  }

  return { render, updateTarget, destroy };
})();
