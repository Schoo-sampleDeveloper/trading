/**
 * Density Viewer - 確率密度ビューア
 * ヒストグラム + カーネル密度推定（KDE）で資産分布を表示。
 * 目標額ドラッグで達成確率をリアルタイム再計算。
 */
'use strict';

const DensityViewer = (function () {
  let _svg = null;
  let _container = null;
  let _currentTab = 'final';
  let _distributions = null;
  let _targetAmount = 0;
  let _onTargetChange = null;
  let _resizeObserver = null;

  function getThemeColors() {
    const isDark = document.body.dataset.theme !== 'light';
    return {
      achieved: isDark ? 'rgba(0, 255, 136, 0.35)' : 'rgba(5, 150, 105, 0.3)',
      notAchieved: isDark ? 'rgba(139, 146, 165, 0.15)' : 'rgba(100, 116, 139, 0.15)',
      kde: isDark ? '#00D9FF' : '#0284C7',
      goalLine: '#FFD60A',
      text: isDark ? '#E8ECF4' : '#1E293B',
      textMuted: isDark ? '#8B92A5' : '#64748B',
    };
  }

  // ─── カーネル密度推定 ──────────────────────────────────
  function kde(values, bandwidth, xGrid) {
    const n = values.length;
    const factor = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));

    return xGrid.map((x) => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const z = (x - values[i]) / bandwidth;
        sum += Math.exp(-0.5 * z * z);
      }
      return { x, y: sum * factor };
    });
  }

  function silvermanBandwidth(values) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(n * 0.25)];
    const q3 = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const h = 0.9 * Math.min(std, iqr / 1.34) * Math.pow(n, -0.2);
    return Math.max(h, (sorted[n - 1] - sorted[0]) / 100);
  }

  // ─── メイン描画 ────────────────────────────────────────
  function render(containerId, distributions, options = {}) {
    const {
      targetAmount = 0,
      onTargetChange = null,
      activeTab = 'final',
    } = options;

    _container = document.getElementById(containerId);
    if (!_container) return;

    _distributions = distributions;
    _targetAmount = targetAmount;
    _onTargetChange = onTargetChange;
    _currentTab = activeTab;

    renderChart();
    setupResize(containerId);
  }

  function renderChart() {
    if (!_container || !_distributions) return;

    const dist = _distributions[_currentTab];
    if (!dist || !dist.values || dist.values.length === 0) {
      _container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">データなし</div>';
      return;
    }

    _container.innerHTML = '';

    const colors = getThemeColors();
    const values = dist.values;
    const n = values.length;

    const rect = _container.getBoundingClientRect();
    const width = rect.width || 600;
    const height = Math.min(rect.height || 320, 320);
    const margin = { top: 20, right: 30, bottom: 45, left: 60 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(_container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('role', 'img')
      .attr('aria-label', '確率密度分布');
    _svg = svg;

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // 値の範囲
    const minVal = values[0];
    const maxVal = values[n - 1];
    const range = maxVal - minVal;
    const xMin = Math.max(0, minVal - range * 0.05);
    const xMax = maxVal + range * 0.05;

    // ヒストグラムビンの計算
    const numBins = Math.min(60, Math.max(20, Math.ceil(Math.sqrt(n))));

    const x = d3.scaleLinear().domain([xMin, xMax]).range([0, innerW]);
    const histogram = d3.bin()
      .domain(x.domain())
      .thresholds(numBins);
    const bins = histogram(values);

    // KDE
    const bandwidth = silvermanBandwidth(values);
    const xGrid = d3.range(xMin, xMax, (xMax - xMin) / 200);
    const kdeData = kde(values, bandwidth, xGrid);

    // Y軸スケール
    const maxDensity = d3.max(kdeData, (d) => d.y) || 1;
    const y = d3.scaleLinear().domain([0, maxDensity * 1.15]).range([innerH, 0]);

    // ヒストグラムのスケール (密度に合わせる)
    const binWidth = bins[0] ? bins[0].x1 - bins[0].x0 : 1;

    // ─── ヒストグラム描画 ────────────────────────────────
    g.selectAll('.mc-density-bar')
      .data(bins)
      .join('rect')
      .attr('class', 'mc-density-bar')
      .attr('x', (d) => x(d.x0) + 0.5)
      .attr('width', (d) => Math.max(0, x(d.x1) - x(d.x0) - 1))
      .attr('y', (d) => y(d.length / (n * binWidth)))
      .attr('height', (d) => innerH - y(d.length / (n * binWidth)))
      .attr('fill', (d) => {
        if (_targetAmount > 0) {
          return d.x0 >= _targetAmount ? colors.achieved : colors.notAchieved;
        }
        return colors.notAchieved;
      })
      .attr('rx', 1);

    // ─── KDE曲線 ─────────────────────────────────────────
    const kdeLine = d3.line()
      .x((d) => x(d.x))
      .y((d) => y(d.y))
      .curve(d3.curveBasis);

    // 塗り分け (目標額の左右)
    if (_targetAmount > 0 && _targetAmount > xMin && _targetAmount < xMax) {
      // 達成領域 (右側)
      const achievedData = kdeData.filter((d) => d.x >= _targetAmount);
      if (achievedData.length > 0) {
        const areaPath = d3.area()
          .x((d) => x(d.x))
          .y0(innerH)
          .y1((d) => y(d.y))
          .curve(d3.curveBasis);

        g.append('path')
          .datum(achievedData)
          .attr('d', areaPath)
          .attr('fill', colors.achieved)
          .attr('opacity', 0.6);
      }
    }

    g.append('path')
      .datum(kdeData)
      .attr('d', kdeLine)
      .attr('fill', 'none')
      .attr('stroke', colors.kde)
      .attr('stroke-width', 2);

    // ─── 目標額ライン ────────────────────────────────────
    if (_targetAmount > 0 && _targetAmount > xMin && _targetAmount < xMax) {
      const goalX = x(_targetAmount);
      const goalGroup = g.append('g').attr('class', 'mc-density-goal');

      goalGroup.append('line')
        .attr('x1', goalX).attr('x2', goalX)
        .attr('y1', 0).attr('y2', innerH)
        .attr('stroke', colors.goalLine)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '6,3');

      // 達成確率ラベル
      const prob = MonteCarloEngine.calcGoalProbability(dist, _targetAmount);
      goalGroup.append('text')
        .attr('x', goalX)
        .attr('y', -6)
        .attr('text-anchor', 'middle')
        .attr('fill', colors.goalLine)
        .attr('font-size', '12px')
        .attr('font-weight', '700')
        .text(`目標 ${MonteCarloEngine.formatJPYCompact(_targetAmount)}`);

      goalGroup.append('text')
        .attr('x', goalX)
        .attr('y', innerH + 32)
        .attr('text-anchor', 'middle')
        .attr('fill', colors.goalLine)
        .attr('font-size', '11px')
        .attr('font-weight', '600')
        .text(`達成確率 ${(prob * 100).toFixed(1)}%`);

      // ドラッグ機能
      const dragHandle = goalGroup.append('rect')
        .attr('x', goalX - 12)
        .attr('y', -4)
        .attr('width', 24)
        .attr('height', innerH + 4)
        .attr('fill', 'transparent')
        .attr('cursor', 'ew-resize');

      const drag = d3.drag()
        .on('drag', function (event) {
          const newX = Math.max(0, Math.min(innerW, event.x));
          const newTarget = x.invert(newX);
          if (newTarget > 0) {
            _targetAmount = newTarget;
            renderChart();
            if (_onTargetChange) _onTargetChange(newTarget);
          }
        });

      dragHandle.call(drag);
    }

    // ─── 軸 ──────────────────────────────────────────────
    const xAxis = d3.axisBottom(x)
      .ticks(6)
      .tickFormat((d) => MonteCarloEngine.formatJPYCompact(d));

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .selectAll('text')
      .attr('fill', colors.textMuted)
      .attr('font-size', '10px');

    // Y軸ラベル (確率密度)
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2)
      .attr('y', -45)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.textMuted)
      .attr('font-size', '10px')
      .text('確率密度');

    // 軸スタイル
    svg.selectAll('.domain, line')
      .attr('stroke', 'var(--border-subtle, rgba(255,255,255,0.1))');

    // 統計ラベル
    const median = values[Math.floor(n * 0.5)];
    const p5 = values[Math.floor(n * 0.05)];
    const p95 = values[Math.floor(n * 0.95)];

    const statsHtml = `
      <div class="mc-density-stats">
        <span>中央値: <b>${MonteCarloEngine.formatJPY(median)}</b></span>
        <span>5-95%: <b>${MonteCarloEngine.formatJPY(p5)}</b> 〜 <b>${MonteCarloEngine.formatJPY(p95)}</b></span>
      </div>
    `;
    const statsDiv = document.createElement('div');
    statsDiv.innerHTML = statsHtml;
    _container.appendChild(statsDiv);
  }

  function setTab(tabKey) {
    _currentTab = tabKey;
    renderChart();
  }

  function setTarget(amount) {
    _targetAmount = amount;
    renderChart();
  }

  function setupResize(containerId) {
    if (_resizeObserver) _resizeObserver.disconnect();
    const el = document.getElementById(containerId);
    if (!el) return;

    let timeout;
    _resizeObserver = new ResizeObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => renderChart(), 200);
    });
    _resizeObserver.observe(el);
  }

  function destroy() {
    if (_resizeObserver) {
      _resizeObserver.disconnect();
      _resizeObserver = null;
    }
    if (_container) _container.innerHTML = '';
    _svg = null;
    _distributions = null;
  }

  return { render, setTab, setTarget, destroy };
})();
