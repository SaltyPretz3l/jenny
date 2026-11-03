/**
 * renderer/inventory/heatmap-calendar.js
 *
 * Calendar heatmap primitive (UMD). A pure function from dated values to one
 * inline SVG string: week columns x 7 day rows (Monday on top), quartile
 * intensity levels 0-4, month labels on top and Mon/Wed/Fri on the left.
 * Colors live in inventory-heatmap.css (data-level), never here. Each cell
 * carries its tooltip text in data-tooltip, which the delegated tooltip system
 * (inventory/tooltip.js) reads from any element, SVG included.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryHeatmapCalendar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CELL = 11;
  var GAP = 3;
  var PITCH = CELL + GAP;
  var RADIUS = 2;
  var LEFT = 24; // gutter for the Mon/Wed/Fri labels
  var TOP = 14; // band for the month labels
  var MONTH_BASELINE = 9;
  var LABEL_SIZE = 9;
  var LEVELS = 5; // 0 (none) .. 4 (most)
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var DEFAULT_DAY_LABELS = ['Mon', 'Wed', 'Fri'];
  var DAY_LABEL_ROWS = [0, 2, 4];

  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  /** 'YYYY-MM-DD' -> local-midnight Date, or null for anything that is not a real calendar date. */
  function parseDateKey(key) {
    var match = DATE_RE.exec(String(key || ''));
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  /** Monday = 0 .. Sunday = 6. */
  function mondayRow(date) {
    return (date.getDay() + 6) % 7;
  }

  function finiteValue(value) {
    var numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  /**
   * Quartile level function over the NON-ZERO values: a value's level is the
   * quartile of its rank among the non-zero values (ties share the highest
   * rank), so a light user still sees contrast and the top day is always 4.
   * @param {number[]} values
   * @returns {function(number):number} value -> 0..4 (0 for zero / negative / NaN)
   */
  function levelFunction(values) {
    var sorted = [];
    for (var i = 0; i < values.length; i += 1) {
      var value = finiteValue(values[i]);
      if (value > 0) sorted.push(value);
    }
    sorted.sort(function (a, b) { return a - b; });
    var total = sorted.length;
    return function levelFor(raw) {
      var value = finiteValue(raw);
      if (value <= 0 || total === 0) return 0;
      var low = 0;
      var high = total;
      while (low < high) { // upper bound: count of values <= value
        var mid = (low + high) >> 1;
        if (sorted[mid] <= value) low = mid + 1;
        else high = mid;
      }
      return Math.min(LEVELS - 1, Math.max(1, Math.ceil(((LEVELS - 1) * low) / total)));
    };
  }

  /** Cells -> valid, date-ordered entries with their Date, dropping unparseable dates. */
  function normalizeCells(cells) {
    var entries = [];
    var source = Array.isArray(cells) ? cells : [];
    for (var i = 0; i < source.length; i += 1) {
      var cell = source[i];
      var date = cell && parseDateKey(cell.date);
      if (!date) continue;
      entries.push({
        key: String(cell.date),
        date: date,
        value: finiteValue(cell.value),
        tooltip: cell.tooltip == null ? '' : String(cell.tooltip),
      });
    }
    entries.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return entries;
  }

  /**
   * Places entries on the week grid. Column 0 starts on the Monday on or
   * before the first entry; when maxWeeks is set and the data spans more
   * weeks, the oldest entries are dropped so only the last maxWeeks columns
   * remain.
   */
  function placeEntries(entries, maxWeeks) {
    if (!entries.length) return { placed: [], columns: 0 };
    var firstRow = mondayRow(entries[0].date);
    var columns = Math.ceil((entries.length + firstRow) / 7);
    var skip = 0;
    if (maxWeeks > 0 && columns > maxWeeks) {
      skip = (columns - maxWeeks) * 7 - firstRow;
      columns = maxWeeks;
      firstRow = 0;
    }
    var placed = [];
    for (var i = skip; i < entries.length; i += 1) {
      var slot = i - skip + firstRow;
      placed.push({ entry: entries[i], col: Math.floor(slot / 7), row: slot % 7 });
    }
    return { placed: placed, columns: columns };
  }

  function monthFormatter(locale) {
    try {
      return new Intl.DateTimeFormat(locale || undefined, { month: 'short' });
    } catch (_error) {
      return { format: function (date) { return String(date.getMonth() + 1); } };
    }
  }

  function attr(name, value) {
    return ' ' + name + '="' + escapeHtml(String(value)) + '"';
  }

  /**
   * Render the heatmap SVG.
   * @param {Object} opts
   * @param {Array<{date:string,value:number,tooltip?:string}>} opts.cells - one per day, 'YYYY-MM-DD' local dates
   * @param {string} [opts.from] - first date of the highlighted span; days outside from..to get data-out-of-range
   * @param {string} [opts.to] - last date of the highlighted span
   * @param {string} [opts.today] - date that gets data-today
   * @param {number} [opts.maxWeeks] - keep at most this many week columns (newest)
   * @param {string} [opts.ariaLabel] - accessible name of the whole figure
   * @param {string} [opts.locale] - BCP 47 tag for month names
   * @param {string[]} [opts.dayLabels] - the three row labels for Mon, Wed, Fri
   * @returns {string} SVG markup ('' when no valid cell was given)
   */
  function heatmapCalendar(opts) {
    var o = opts || {};
    var entries = normalizeCells(o.cells);
    if (!entries.length) return '';
    var grid = placeEntries(entries, Number(o.maxWeeks) || 0);
    var levelFor = levelFunction(grid.placed.map(function (item) { return item.entry.value; }));
    var from = o.from && parseDateKey(o.from) ? String(o.from) : '';
    var to = o.to && parseDateKey(o.to) ? String(o.to) : '';
    var months = monthFormatter(o.locale);
    var dayLabels = Array.isArray(o.dayLabels) && o.dayLabels.length >= 3 ? o.dayLabels : DEFAULT_DAY_LABELS;

    var cellsMarkup = '';
    var labelsMarkup = '';
    var lastMonth = -1;
    for (var i = 0; i < grid.placed.length; i += 1) {
      var item = grid.placed[i];
      var entry = item.entry;
      var x = LEFT + item.col * PITCH;
      var y = TOP + item.row * PITCH;
      var outOfRange = (from && entry.key < from) || (to && entry.key > to);
      cellsMarkup += '<rect class="inv-heatmap-cell"'
        + attr('x', x) + attr('y', y) + attr('width', CELL) + attr('height', CELL) + attr('rx', RADIUS)
        + attr('data-date', entry.key)
        + attr('data-level', levelFor(entry.value))
        + (outOfRange ? ' data-out-of-range="true"' : '')
        + (o.today && entry.key === o.today ? ' data-today="true"' : '')
        + (entry.tooltip ? attr('data-tooltip', entry.tooltip) : '')
        + ' tabindex="-1"/>';
      // A month is labeled above the column of its first Monday.
      if (item.row === 0 && entry.date.getDate() <= 7 && entry.date.getMonth() !== lastMonth) {
        lastMonth = entry.date.getMonth();
        labelsMarkup += '<text class="inv-heatmap-label"' + attr('font-size', LABEL_SIZE)
          + attr('x', x) + attr('y', MONTH_BASELINE) + '>' + escapeHtml(months.format(entry.date)) + '</text>';
      }
    }
    for (var d = 0; d < DAY_LABEL_ROWS.length; d += 1) {
      var label = String(dayLabels[d] == null ? '' : dayLabels[d]);
      if (!label) continue;
      labelsMarkup += '<text class="inv-heatmap-label"' + attr('font-size', LABEL_SIZE)
        + attr('x', 0) + attr('y', TOP + DAY_LABEL_ROWS[d] * PITCH + CELL - 2) + '>' + escapeHtml(label) + '</text>';
    }

    var width = LEFT + grid.columns * PITCH - GAP;
    var height = TOP + 7 * PITCH - GAP;
    return '<svg class="inv-heatmap"' + attr('viewBox', '0 0 ' + width + ' ' + height)
      + ' role="img"' + (o.ariaLabel ? attr('aria-label', o.ariaLabel) : '') + ' focusable="false">'
      + labelsMarkup + cellsMarkup + '</svg>';
  }

  /**
   * The five legend swatches (levels 0..4); callers put their own "Less" / "More" around them.
   * @returns {string} HTML string
   */
  function legend() {
    var out = '';
    for (var level = 0; level < LEVELS; level += 1) {
      out += '<span class="inv-heatmap-swatch" data-level="' + level + '"></span>';
    }
    return out;
  }

  heatmapCalendar.legend = legend;
  heatmapCalendar.levelFunction = levelFunction;
  heatmapCalendar.parseDateKey = parseDateKey;
  return heatmapCalendar;
});
