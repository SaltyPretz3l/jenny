/* Home dashboard "Usage" widget (row 98): the range's token headline, six
 * stats and a year heatmap, from one usage.getStats read. The descriptor is
 * headerless: the widget draws its own header row inside the card body so the
 * range control can sit on the section hairline (markup contract:
 * docs/plans/HOME_USAGE_STATS_2026-11-01.md). Switching range re-renders from
 * the cached read and never calls the bridge; a read happens on the first
 * paint and on each Home activation, with at most one in flight and no polling.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardWidgetUsageStats = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const WIDGET_ID = 'usage-stats';
  const RANGE_KEYS = ['1d', '7d', '30d', '6mo', '1y', 'all'];
  const DEFAULT_RANGE = '7d';
  const HEAT_WEEKS = 53;
  // "Just upgraded": the rollup was seeded from the 30 retained days, so a
  // first record this recent with nothing older on the map reads as a backfill.
  const UPGRADE_WINDOW_DAYS = 31;
  const DASH = '—';
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function localeTag() {
    return globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined;
  }

  function normalizeRange(value) {
    return RANGE_KEYS.includes(value) ? value : DEFAULT_RANGE;
  }

  // 'YYYY-MM-DD' -> local-midnight Date (null when not a date).
  function parseKey(key) {
    const match = DATE_RE.exec(String(key || ''));
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }

  // Whole days from..to inclusive (UTC math, so a DST day cannot skew it).
  function daysInclusive(fromKey, toKey) {
    const from = parseKey(fromKey);
    const to = parseKey(toKey);
    if (!from || !to) return 0;
    const utc = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.max(0, Math.round((utc(to) - utc(from)) / 86400000) + 1);
  }

  // Intl formatters are costly to build and a paint formats ~371 heatmap tips,
  // so each (kind, locale, options) is built once.
  const formatters = new Map();
  function formatter(Kind, options) {
    const cacheKey = Kind.name + '|' + (localeTag() || '') + '|' + JSON.stringify(options);
    if (!formatters.has(cacheKey)) formatters.set(cacheKey, new Kind(localeTag(), options));
    return formatters.get(cacheKey);
  }

  function formatDate(key, options) {
    const date = parseKey(key);
    if (!date) return '';
    try {
      return formatter(Intl.DateTimeFormat, options).format(date);
    } catch (_error) {
      return key;
    }
  }

  const shortDate = (key, withYear) => formatDate(key, withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' });
  const weekdayDate = (key) => formatDate(key, { weekday: 'short', month: 'short', day: 'numeric' });

  // 833K, 1.24M, 27.3M: three significant digits, exact below one thousand.
  function compact(value) {
    const number = Number(value) || 0;
    if (number < 1000) return Math.round(number).toLocaleString(localeTag());
    try {
      return formatter(Intl.NumberFormat, { notation: 'compact', maximumSignificantDigits: 3 }).format(number);
    } catch (_error) {
      return String(Math.round(number));
    }
  }

  function percent(share) {
    try {
      return formatter(Intl.NumberFormat, { style: 'percent', maximumFractionDigits: 0 }).format(Number(share) || 0);
    } catch (_error) {
      return Math.round((Number(share) || 0) * 100) + '%';
    }
  }

  // "9 pm": the locale's own hour format, with an English AM/PM kept lowercase.
  function hourLabel(hour) {
    try {
      return formatter(Intl.DateTimeFormat, { hour: 'numeric' }).format(new Date(2024, 0, 1, hour))
        .replace(/[\u202f\u00a0]/g, ' ').replace(/\b(AM|PM)\b/g, (token) => token.toLowerCase());
    } catch (_error) {
      return String(hour) + ':00';
    }
  }

  // Mon / Wed / Fri in the locale (2024-01-01 is a Monday).
  function dayLabels() {
    try {
      const format = formatter(Intl.DateTimeFormat, { weekday: 'short' });
      return [1, 3, 5].map((day) => format.format(new Date(2024, 0, day)));
    } catch (_error) {
      return ['Mon', 'Wed', 'Fri'];
    }
  }

  function replies(count) {
    const total = Number(count) || 0;
    return jtn('dashboard.usageStats.replies', total, { count: total.toLocaleString(localeTag()) }, '{count} reply', '{count} replies');
  }

  function spanText(stats, range) {
    const info = asObject(stats.ranges[range]) || {};
    if (range === '1d') return jt('dashboard.usageStats.today', 'Today');
    const to = String(info.to || '');
    const toYear = (parseKey(to) || new Date()).getFullYear();
    if (range === 'all') {
      const since = String(stats.since || info.from || '');
      return since ? jt('dashboard.usageStats.since', 'Since {date}', { date: shortDate(since, (parseKey(since) || new Date()).getFullYear() !== toYear) }) : '';
    }
    const from = String(info.from || '');
    if (!from || !to) return '';
    const crossesYear = (parseKey(from) || new Date()).getFullYear() !== toYear;
    return shortDate(from, crossesYear) + ' – ' + shortDate(to, false);
  }

  function statItems(stats, info) {
    const favorite = asObject(info.favorite_model);
    const rest = (Array.isArray(info.top_models) ? info.top_models : []).slice(1, 3)
      .map((entry) => entry.model + ' ' + percent(entry.share)).join(', ');
    const busiest = asObject(info.busiest_day);
    const streak = asObject(stats.streak) || {};
    const current = Number(streak.current) || 0;
    const longest = Number(streak.longest) || 0;
    const hasPeak = Number.isInteger(info.peak_hour);
    const speed = Number(info.avg_tokens_per_second);
    const favoriteTip = favorite
      ? jt('dashboard.usageStats.favoriteTip', '{model} on {provider}. Replies: {turns} of {total}.', {
        model: favorite.model, provider: favorite.provider || DASH, turns: Number(favorite.turns) || 0, total: Number(info.turns) || 0,
      }) + (rest ? ' ' + jt('dashboard.usageStats.favoriteNext', 'Next: {others}', { others: rest }) : '')
      : '';
    return [
      {
        label: jt('dashboard.usageStats.favorite', 'Favorite model'),
        value: favorite ? favorite.model : DASH,
        aside: favorite ? percent(favorite.share) : '',
        tip: favoriteTip,
      },
      {
        label: jt('dashboard.usageStats.streak', 'Streak'),
        value: jtn('dashboard.usageStats.streakDays', current, { count: current.toLocaleString(localeTag()) }, '{count} day', '{count} days'),
        aside: longest > 0 ? jt('dashboard.usageStats.streakBest', 'best {count}', { count: longest.toLocaleString(localeTag()) }) : '',
        tip: jt('dashboard.usageStats.streakTip', 'Days in a row with at least one reply. Active days in this range: {active} of {total}', {
          active: Number(info.active_days) || 0, total: daysInclusive(info.from, info.to),
        }),
      },
      {
        label: jt('dashboard.usageStats.local', 'Local'),
        value: info.local_share == null ? DASH : percent(info.local_share),
        aside: '',
        tip: jt('dashboard.usageStats.localTip', 'Replies from models on this PC'),
      },
      {
        label: jt('dashboard.usageStats.busiest', 'Busiest day'),
        value: busiest ? shortDate(busiest.date, false) : DASH,
        aside: busiest ? compact(busiest.total_tokens) : '',
        tip: busiest ? jt('dashboard.usageStats.busiestTip', '{date}: {replies}', { date: weekdayDate(busiest.date), replies: replies(busiest.turns) }) : '',
      },
      {
        label: jt('dashboard.usageStats.peak', 'Peak hour'),
        value: hasPeak ? hourLabel(info.peak_hour) : DASH,
        aside: '',
        tip: jt('dashboard.usageStats.peakTip', 'When you use Jenny most in this range'),
      },
      {
        label: jt('dashboard.usageStats.speed', 'Speed'),
        value: speed > 0
          ? jt('dashboard.usageStats.speedValue', '{value} tok/s', { value: speed.toLocaleString(localeTag(), { maximumFractionDigits: speed >= 10 ? 0 : 1 }) })
          : DASH,
        aside: '',
        tip: jt('dashboard.usageStats.speedTip', 'Average generation speed across replies'),
      },
    ];
  }

  // The rollup began recently and nothing older is on the map.
  function isJustUpgraded(stats) {
    const since = String(stats.since || '');
    const today = String(asObject(stats.ranges['1d'])?.to || '');
    if (!since || !today) return false;
    const age = daysInclusive(since, today) - 1;
    if (age < 0 || age >= UPGRADE_WINDOW_DAYS) return false;
    return stats.heatmap.every((cell) => cell.date >= since || (!cell.total_tokens && !cell.turns));
  }

  function createUsageStatsWidget(deps = {}) {
    const segmentedControl = deps.segmentedControl || windowRef.inventorySegmentedControl || null;
    const emptyNote = deps.emptyNote || windowRef.inventoryEmptyNote || null;
    const heatmapCalendar = deps.heatmapCalendar || windowRef.inventoryHeatmapCalendar || null;
    const onHomeConfig = typeof deps.onHomeConfig === 'function' ? deps.onHomeConfig : null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : () => {};
    const getShell = () => deps.shell || windowRef.jennyShell || null;

    let stats = null; // last good payload
    let status = 'idle'; // idle | loading | ready | empty | error
    let version = 0; // bumps when a read brings different data (render key)
    let lastSignature = '';
    let cellsCache = null; // heatmap cells for (version, locale): tips do not change with the range
    let inFlight = null;
    let needsFetch = true;
    let rangeTouched = false;
    let localRange = DEFAULT_RANGE;
    let lastBody = null;
    let lastCtx = null;
    let observer = null;
    let disposed = false;
    const boundBodies = new WeakSet();

    // Until the user picks one, the persisted config value wins (it can arrive
    // after the first paint); a pick is optimistic and owned locally.
    function currentRange(ctx) {
      if (rangeTouched) return localRange;
      return normalizeRange(asObject(ctx?.state?.homeConfig?.usageStats)?.range);
    }

    function persistRange(next) {
      const shell = getShell();
      if (!shell?.home?.updateConfig) return;
      Promise.resolve(shell.home.updateConfig({ usageStats: { range: next } }))
        .then((config) => {
          if (config && onHomeConfig) onHomeConfig(config);
        })
        .catch((error) => {
          appendClientLog('WARN', 'home.usage_stats_range_persist_failed', { message: String(error?.message || error || '') });
        });
    }

    function applyRead(payload) {
      const ranges = asObject(payload?.ranges);
      const all = asObject(ranges?.all);
      if (payload?.available !== true || !ranges || !all || !Array.isArray(payload.heatmap)) {
        throw new Error(String(payload?.error || 'usage_stats_unavailable'));
      }
      // Same data as last time (a Home revisit with no new replies): keep the
      // render key so the card, its hover and its focus are left alone.
      const signature = JSON.stringify(payload);
      if (signature === lastSignature && stats) return;
      lastSignature = signature;
      version += 1;
      stats = {
        since: payload.since || null,
        ranges,
        streak: asObject(payload.streak) || { current: 0, longest: 0 },
        heatmap: payload.heatmap,
      };
      status = Number(all.turns) > 0 ? 'ready' : 'empty';
    }

    function repaint() {
      if (!disposed && lastBody && lastCtx) paint(lastBody, lastCtx);
    }

    function startRefresh() {
      if (inFlight) return inFlight;
      needsFetch = false;
      const usage = getShell()?.usage;
      if (stats === null) status = 'loading';
      inFlight = Promise.resolve().then(() => {
        if (typeof usage?.getStats !== 'function') throw new Error('usage_bridge_unavailable');
        return usage.getStats();
      }).then((payload) => {
        if (disposed) return;
        applyRead(payload);
      }).catch((error) => {
        if (disposed) return;
        // A failed refresh keeps the last good stats on screen; the error shows
        // only when there is nothing to show.
        if (stats === null) status = 'error';
        appendClientLog('WARN', 'home.usage_stats_read_failed', { message: String(error?.message || error || '') });
      }).then(() => {
        inFlight = null;
        repaint();
      });
      return inFlight;
    }

    // A new Home activation is the only refresh trigger besides the first
    // paint. One already in flight is fresh enough, so it absorbs the new one.
    function onActivated() {
      if (disposed || inFlight) return;
      needsFetch = true;
      if (lastBody && lastBody.isConnected !== false && lastCtx) startRefresh();
    }

    function onViewMutations(records) {
      const current = records[records.length - 1].target.getAttribute('data-active-view');
      for (let index = 0; index < records.length; index += 1) {
        const next = index < records.length - 1 ? records[index + 1].oldValue : current;
        if (next === 'home' && records[index].oldValue !== 'home') {
          onActivated();
          return;
        }
      }
    }

    function observeActivation(doc) {
      const Observer = doc?.defaultView?.MutationObserver;
      if (observer || !Observer || !doc.documentElement) return;
      observer = new Observer(onViewMutations);
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-active-view'], attributeOldValue: true });
    }

    function onRangeChange(event) {
      const group = event.target?.closest?.('[data-inv-segmented="usage-range"]');
      const next = String(event.detail?.value || '');
      if (!group || !RANGE_KEYS.includes(next) || (rangeTouched && next === localRange)) return;
      rangeTouched = true;
      localRange = next;
      persistRange(next);
      const wasFocused = group.contains(group.ownerDocument.activeElement);
      repaint();
      if (wasFocused) lastBody?.querySelector('.inv-segmented-option[data-value="' + next + '"]')?.focus();
    }

    function headerMarkup(range, withRange) {
      let tail = '';
      if (withRange && segmentedControl) {
        const labels = {
          '1d': jt('dashboard.usageStats.range1d', '1d'),
          '7d': jt('dashboard.usageStats.range7d', '7d'),
          '30d': jt('dashboard.usageStats.range30d', '30d'),
          '6mo': jt('dashboard.usageStats.range6mo', '6mo'),
          '1y': jt('dashboard.usageStats.range1y', '1yr'),
          all: jt('dashboard.usageStats.rangeAll', 'All'),
        };
        const tips = {
          '1d': jt('dashboard.usageStats.range1dTip', 'Today, since midnight'),
          all: jt('dashboard.usageStats.rangeAllTip', 'Everything since Jenny started counting'),
        };
        const control = segmentedControl({
          id: 'usage-range',
          className: 'inv-segmented--compact us-range',
          ariaLabel: jt('dashboard.usageStats.rangeAria', 'Usage range'),
          value: range,
          maxOptions: RANGE_KEYS.length,
          options: RANGE_KEYS.map((value) => (tips[value]
            ? { value, label: labels[value], tooltip: tips[value] }
            : { value, label: labels[value] })),
        });
        tail = '<div class="us-head-tail"><span class="us-span">' + escapeHtml(spanText(stats, range)) + '</span>' + control + '</div>';
      }
      return '<div class="dashboard-card__header"><h3 class="dashboard-card__title">'
        + escapeHtml(jt('dashboard.usageStats.title', 'Usage')) + '</h3>' + tail + '</div>';
    }

    function heatmapMarkup(info) {
      const todayKey = String(asObject(stats.ranges['1d'])?.to || '');
      const cellsKey = version + '|' + (localeTag() || '');
      const cells = cellsCache?.key === cellsKey ? cellsCache.cells : stats.heatmap.map((cell) => {
        const turns = Number(cell.turns) || 0;
        const label = weekdayDate(cell.date);
        return {
          date: cell.date,
          value: cell.total_tokens,
          tooltip: turns > 0
            ? jt('dashboard.usageStats.heatTip', '{date} · {tokens} tokens · {replies}', { date: label, tokens: compact(cell.total_tokens), replies: replies(turns) })
            : jt('dashboard.usageStats.heatTipNone', '{date} · no replies', { date: label }),
        };
      });
      cellsCache = { key: cellsKey, cells };
      const svg = heatmapCalendar ? heatmapCalendar({
        cells,
        from: info.from,
        to: info.to,
        today: todayKey,
        maxWeeks: HEAT_WEEKS,
        locale: localeTag(),
        dayLabels: dayLabels(),
        ariaLabel: jt('dashboard.usageStats.heatAria', 'Token use per day over the last year'),
      }) : '';
      const year = asObject(stats.ranges['1y']) || {};
      const foot = isJustUpgraded(stats)
        ? jt('dashboard.usageStats.heatCounting', 'Counting since {date} (Jenny kept 30 days before this update)', {
          date: shortDate(stats.since, (parseKey(stats.since) || new Date()).getFullYear() !== (parseKey(todayKey) || new Date()).getFullYear()),
        })
        : jt('dashboard.usageStats.heatFoot', '{tokens} tokens in the last year', { tokens: compact(year.total_tokens) });
      const legend = jt('dashboard.usageStats.legendLess', 'Less') + ' ' + (heatmapCalendar ? heatmapCalendar.legend() : '')
        + ' ' + jt('dashboard.usageStats.legendMore', 'More');
      return '<div class="us-heat">' + svg + '<div class="us-heat-foot"><span>' + escapeHtml(foot)
        + '</span><span class="us-legend">' + legend + '</span></div></div>';
    }

    function readyMarkup(range) {
      const info = asObject(stats.ranges[range]) || {};
      const input = compact(info.input_tokens);
      const output = compact(info.output_tokens);
      const headline = '<div class="us-headline"><div class="us-big" data-tooltip="'
        + escapeHtml(jt('dashboard.usageStats.headlineTip', "{input} in (your messages, files and tool results) · {output} out (Jenny's replies)", { input, output })) + '">'
        + escapeHtml(compact(info.total_tokens)) + '<small>' + escapeHtml(jt('dashboard.usageStats.tokens', 'tokens')) + '</small></div>'
        + '<div class="us-split">' + escapeHtml([
          replies(info.turns),
          jt('dashboard.usageStats.splitIn', '{value} in', { value: input }),
          jt('dashboard.usageStats.splitOut', '{value} out', { value: output }),
        ].join(' · ')) + '</div></div>';
      const items = statItems(stats, info).map((item) => '<div class="us-stat"'
        + (item.tip ? ' data-tooltip="' + escapeHtml(item.tip) + '"' : '') + '><dt>' + escapeHtml(item.label) + '</dt><dd>'
        + escapeHtml(item.value) + (item.aside ? '<span>' + escapeHtml(item.aside) + '</span>' : '') + '</dd></div>').join('');
      return headerMarkup(range, true) + '<div class="us-body">' + headline
        + '<dl class="us-stats">' + items + '</dl>' + heatmapMarkup(info) + '</div>';
    }

    function buildMarkup(range) {
      if (status === 'ready' && stats) return readyMarkup(range);
      if (status === 'empty') {
        return headerMarkup(range, false) + (emptyNote
          ? emptyNote({ text: jt('dashboard.usageStats.empty', 'No usage yet. Your token stats and a year heatmap fill in after your first reply.') })
          : '');
      }
      if (status === 'error') {
        return headerMarkup(range, false) + '<p class="inv-empty-note us-error" role="status">'
          + escapeHtml(jt('dashboard.usageStats.error', 'Usage stats could not be loaded.')) + '</p>';
      }
      return headerMarkup(range, false);
    }

    function paint(body, ctx) {
      const range = currentRange(ctx);
      const renderKey = [status, range, version, localeTag() || ''].join('|');
      if (body.dataset.usageStatsRenderKey === renderKey) return;
      body.innerHTML = buildMarkup(range);
      body.dataset.usageStatsRenderKey = renderKey;
    }

    function render(body, ctx) {
      lastBody = body;
      lastCtx = ctx;
      if (!boundBodies.has(body)) {
        boundBodies.add(body);
        body.addEventListener('inv-segmented-change', onRangeChange);
      }
      observeActivation(ctx?.documentRef || deps.documentRef || body.ownerDocument);
      if (needsFetch) startRefresh();
      paint(body, ctx);
    }

    function dispose() {
      disposed = true;
      observer?.disconnect();
      observer = null;
      lastBody?.removeEventListener?.('inv-segmented-change', onRangeChange);
      lastBody = null;
      lastCtx = null;
    }

    return { id: WIDGET_ID, title: jt('dashboard.usageStats.title', 'Usage'), headerless: true, render, refresh: startRefresh, dispose };
  }

  return { createUsageStatsWidget };
});
