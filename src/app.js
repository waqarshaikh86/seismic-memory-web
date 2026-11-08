(function () {
  'use strict';

  // Seismic Memory: a rotatable globe of every magnitude 6+ earthquake since 1900.
  // Data: USGS Earthquake Hazards Program catalog, fetched as CSV when the app opens.
  // The only outside origin used is https://earthquake.usgs.gov (declared in manifest.json).

  var root = document.getElementById('app');
  var G = window.SeismicGlobeLibs;

  var FIRST_YEAR = 1900;
  var LAST_YEAR = new Date().getUTCFullYear();
  var DEPTH_COLORS = ['#ffd34e', '#ef5d6b', '#9a7bff'];
  var DEPTH_LABELS = ['Shallow, under 70 km', 'Intermediate, 70 to 300 km', 'Deep, over 300 km'];
  var MAG_COLORS = ['#ffe08a', '#ff9f43', '#ef4444', '#ff2fa0'];
  var MAG_LABELS = ['M6 to 6.9', 'M7 to 7.9', 'M8 to 8.9', 'M9+'];
  var NEUTRAL = '#93a1bd';
  var HOME_ROTATION = [-170, -12];
  var HALF_PI = Math.PI / 2;

  var state = {
    quakes: [],
    skipped: 0,
    year: LAST_YEAR,
    minMag: 6,
    colorBy: 'depth',
    depthOn: [true, true, true],
    decade: null,
    playing: false,
    spinning: true,
    selected: null,
    zoom: 1,
    rot: [HOME_ROTATION[0], HOME_ROTATION[1]],
    loadedAt: null,
    loaded: false,
    blockedMsg: ''
  };

  var ui = {};
  var ctx = null;
  var projection = null;
  var pathGen = null;
  var graticule = null;
  var W = 0;
  var H = 0;
  var dirty = true;
  var dragging = false;
  var moved = false;
  var dragLast = [0, 0];
  var dragStart = [0, 0];
  var decadeBars = [];

  // ---------- small helpers (safe DOM only: textContent, never innerHTML) ----------

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function fmt(n) {
    return Number(n).toLocaleString('en-US');
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function depthClass(d) {
    return d < 70 ? 0 : (d < 300 ? 1 : 2);
  }

  function colorFor(q) {
    if (state.colorBy === 'mag') { return MAG_COLORS[clamp(Math.floor(q.mag) - 6, 0, 3)]; }
    return DEPTH_COLORS[depthClass(q.depth)];
  }

  function dotRadius(mag) {
    return (1.1 + (mag - 5.9) * 1.8) * Math.sqrt(state.zoom);
  }

  function dataUrl() {
    var end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&starttime=1900-01-01&endtime=' +
      end + '&minmagnitude=6&eventtype=earthquake&orderby=time-asc';
  }

  // ---------- CSV parsing (quoted fields contain commas, e.g. place names) ----------

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var n = text.length;
    var c;
    while (i < n) {
      c = text.charCodeAt(i);
      if (inQuotes) {
        if (c === 34) {
          if (text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += text.charAt(i); i++; continue;
      }
      if (c === 34) { inQuotes = true; i++; continue; }
      if (c === 44) { row.push(field); field = ''; i++; continue; }
      if (c === 10 || c === 13) {
        if (c === 13 && text.charCodeAt(i + 1) === 10) { i++; }
        row.push(field); field = ''; i++;
        if (row.length > 1 || row[0] !== '') { rows.push(row); }
        row = [];
        continue;
      }
      field += text.charAt(i); i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toQuakes(rows) {
    var idx = {};
    rows[0].forEach(function (name, k) { idx[name] = k; });
    ['time', 'latitude', 'longitude', 'depth', 'mag', 'place', 'id'].forEach(function (col) {
      if (!(col in idx)) { throw new Error('Unexpected data format: column "' + col + '" is missing.'); }
    });
    var out = [];
    var skipped = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var lat = parseFloat(row[idx.latitude]);
      var lon = parseFloat(row[idx.longitude]);
      var mag = parseFloat(row[idx.mag]);
      var t = row[idx.time] || '';
      var y = parseInt(t.slice(0, 4), 10);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(mag) || !isFinite(y)) { skipped++; continue; }
      var depth = parseFloat(row[idx.depth]);
      out.push({
        t: t, y: y, lat: lat, lon: lon, mag: mag,
        depth: isFinite(depth) ? depth : 0,
        place: row[idx.place] || '',
        id: row[idx.id] || ''
      });
    }
    return { quakes: out, skipped: skipped };
  }

  // ---------- page shell ----------

  function card(parent, label) {
    var c = h('div', 'card');
    var v = h('div', 'card-value', '-');
    c.appendChild(v);
    c.appendChild(h('div', 'card-label', label));
    parent.appendChild(c);
    return v;
  }

  function buildShell() {
    root.textContent = '';
    var shell = h('div', 'shell');

    var top = h('header', 'top');
    ui.title = h('h1', 'title', 'Loading 125 years of earthquakes');
    ui.sub = h('p', 'sub', 'Fetching every magnitude 6+ earthquake since 1900 from the USGS catalog.');
    top.appendChild(ui.title);
    top.appendChild(ui.sub);

    var main = h('main', 'main');

    ui.stage = h('div', 'stage');
    ui.canvas = h('canvas', 'globe');
    ui.canvas.setAttribute('role', 'img');
    ui.canvas.setAttribute('aria-label', 'Rotatable globe showing earthquakes of magnitude 6 and above since 1900');
    ui.yearBadge = h('div', 'yearbadge', String(LAST_YEAR));
    ui.status = h('div', 'status', 'Loading earthquakes from USGS...');
    ui.stage.appendChild(ui.canvas);
    ui.stage.appendChild(ui.yearBadge);
    // On-globe key: real dot sizes (at default zoom), the age fade, and how to interact.
    var key = h('div', 'key');
    var kSize = h('div', 'key-row');
    kSize.appendChild(h('span', 'key-label', 'Size = magnitude'));
    var kDots = h('span', 'key-dots');
    [6, 7, 8, 9].forEach(function (m) {
      var item = h('span', 'key-dot');
      var d = h('span', 'key-circle');
      var px = 2 * (1.1 + (m - 5.9) * 1.8);
      d.style.width = px.toFixed(1) + 'px';
      d.style.height = px.toFixed(1) + 'px';
      item.appendChild(d);
      item.appendChild(h('span', '', String(m)));
      kDots.appendChild(item);
    });
    kSize.appendChild(kDots);
    key.appendChild(kSize);
    var kAge = h('div', 'key-row');
    kAge.appendChild(h('span', 'key-label', 'Fade = age'));
    var kBar = h('span', 'key-fade');
    kBar.appendChild(h('span', 'key-fade-bar'));
    var kEnds = h('span', 'key-fade-ends');
    kEnds.appendChild(h('span', '', 'selected year'));
    kEnds.appendChild(h('span', '', '45+ yrs earlier'));
    kBar.appendChild(kEnds);
    kAge.appendChild(kBar);
    key.appendChild(kAge);
    key.appendChild(h('div', 'key-hint', 'Drag to rotate \u00b7 Scroll to zoom \u00b7 Click a dot for details'));
    ui.stage.appendChild(key);
    ui.stage.appendChild(ui.status);

    // View controls live on the globe itself, not in the filter panel.
    var tools = h('div', 'stage-tools');
    ui.spinBtn = h('button', 'btn small', 'Pause spin');
    ui.spinBtn.type = 'button';
    ui.resetBtn = h('button', 'btn small', 'Reset view');
    ui.resetBtn.type = 'button';
    tools.appendChild(ui.spinBtn);
    tools.appendChild(ui.resetBtn);
    ui.stage.appendChild(tools);

    var panel = h('aside', 'panel');

    var cards = h('div', 'cards');
    ui.statShown = card(cards, 'Earthquakes shown');
    ui.statBig = card(cards, 'Strongest so far');
    ui.statM8 = card(cards, 'Magnitude 8 and above');
    panel.appendChild(cards);

    // Color mode: dots can be colored by depth (default) or by magnitude.
    var colorGroup = h('section', 'group');
    var cRow = h('div', 'row');
    var cLabel = h('span', 'field-label inline', 'Color dots by');
    cRow.appendChild(cLabel);
    var cSeg = h('div', 'seg two');
    ui.colorBtns = [['depth', 'Depth'], ['mag', 'Magnitude']].map(function (pair) {
      var b = h('button', 'chip', pair[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', pair[0] === state.colorBy ? 'true' : 'false');
      b.addEventListener('click', function () { setColorBy(pair[0]); });
      cSeg.appendChild(b);
      return b;
    });
    cRow.appendChild(cSeg);
    colorGroup.appendChild(cRow);
    ui.magLegend = h('div', 'mag-legend');
    ui.magLegend.hidden = true;
    MAG_LABELS.forEach(function (label, k) {
      var item = h('span', 'mag-item');
      var dot = h('span', 'dot');
      dot.style.background = MAG_COLORS[k];
      item.appendChild(dot);
      item.appendChild(h('span', '', label));
      ui.magLegend.appendChild(item);
    });
    colorGroup.appendChild(ui.magLegend);
    panel.appendChild(colorGroup);

    // One Filters card: Year, Magnitude, Depth, Decade, each with its label above.
    var filters = h('section', 'group');
    var fhead = h('div', 'group-head');
    fhead.appendChild(h('h2', 'group-title', 'Filters'));
    ui.clearBtn = h('button', 'link', 'Reset filters');
    ui.clearBtn.type = 'button';
    ui.clearBtn.addEventListener('click', resetFilters);
    fhead.appendChild(ui.clearBtn);
    filters.appendChild(fhead);

    var fYear = h('div', 'field');
    var fyHead = h('div', 'field-head');
    fyHead.appendChild(h('span', 'field-label', 'Up to year'));
    ui.yearLabel = h('span', 'year-label', String(LAST_YEAR));
    fyHead.appendChild(ui.yearLabel);
    fYear.appendChild(fyHead);
    var r1 = h('div', 'row');
    ui.playBtn = h('button', 'btn', 'Play');
    ui.playBtn.type = 'button';
    ui.slider = h('input', 'slider');
    ui.slider.type = 'range';
    ui.slider.min = String(FIRST_YEAR);
    ui.slider.max = String(LAST_YEAR);
    ui.slider.step = '1';
    ui.slider.value = String(LAST_YEAR);
    ui.slider.setAttribute('aria-label', 'Show earthquakes up to this year');
    r1.appendChild(ui.playBtn);
    r1.appendChild(ui.slider);
    fYear.appendChild(r1);
    filters.appendChild(fYear);

    var fMag = h('div', 'field');
    fMag.appendChild(h('span', 'field-label', 'Minimum magnitude'));
    var seg = h('div', 'seg');
    ui.magBtns = [6, 7, 8].map(function (m) {
      var b = h('button', 'chip', 'M' + m + '+');
      b.type = 'button';
      b.setAttribute('aria-pressed', m === state.minMag ? 'true' : 'false');
      b.addEventListener('click', function () { setMinMag(m); });
      seg.appendChild(b);
      return b;
    });
    fMag.appendChild(seg);
    filters.appendChild(fMag);

    var fDepth = h('div', 'field');
    fDepth.appendChild(h('span', 'field-label', 'Depth (click to show or hide)'));
    var dg = h('div', 'depth-grid');
    var DEPTH_SHORT = [['Shallow', '< 70 km'], ['Mid', '70 to 300 km'], ['Deep', '> 300 km']];
    ui.depthDots = [];
    ui.depthBtns = DEPTH_SHORT.map(function (pair, k) {
      var item = h('button', 'depth-chip');
      item.type = 'button';
      item.setAttribute('aria-pressed', 'true');
      item.setAttribute('aria-label', DEPTH_LABELS[k]);
      var top = h('span', 'depth-top');
      var dot = h('span', 'dot');
      dot.style.background = DEPTH_COLORS[k];
      ui.depthDots.push(dot);
      top.appendChild(dot);
      top.appendChild(h('span', '', pair[0]));
      item.appendChild(top);
      item.appendChild(h('span', 'depth-sub', pair[1]));
      item.addEventListener('click', function () { setDepth(k); });
      dg.appendChild(item);
      return item;
    });
    fDepth.appendChild(dg);
    filters.appendChild(fDepth);

    var fDec = h('div', 'field');
    var decLabel = h('label', 'field-label', 'Decade');
    decLabel.setAttribute('for', 'decade-select');
    ui.decadeSel = h('select', 'select');
    ui.decadeSel.id = 'decade-select';
    var optAll = h('option', '', 'All decades');
    optAll.value = 'all';
    ui.decadeSel.appendChild(optAll);
    for (var dd = FIRST_YEAR; dd <= LAST_YEAR; dd += 10) {
      var opt = h('option', '', dd + 's');
      opt.value = String(dd);
      ui.decadeSel.appendChild(opt);
    }
    ui.decadeSel.addEventListener('change', function () {
      setDecade(ui.decadeSel.value === 'all' ? null : parseInt(ui.decadeSel.value, 10));
    });
    fDec.appendChild(decLabel);
    fDec.appendChild(ui.decadeSel);
    filters.appendChild(fDec);

    panel.appendChild(filters);

    var dec = h('section', 'group');
    dec.appendChild(h('h2', 'group-title', 'Quakes per decade'));
    ui.decades = svgEl('svg', { 'class': 'decades', viewBox: '0 0 300 70', role: 'img' });
    ui.decades.setAttribute('aria-label', 'Number of earthquakes recorded in each decade');
    dec.appendChild(ui.decades);
    dec.appendChild(h('p', 'muted',
      'Click a bar to filter. Early decades are undercounted.'));
    panel.appendChild(dec);

    var det = h('section', 'group detail-group');
    det.appendChild(h('h2', 'group-title', 'Selected earthquake'));
    ui.detailBody = h('div', 'detail');
    det.appendChild(ui.detailBody);
    panel.appendChild(det);

    main.appendChild(ui.stage);
    main.appendChild(panel);

    ui.foot = h('footer', 'foot', 'Source: USGS Earthquake Hazards Program catalog. Created by Waqar Ahmed Shaikh.');

    shell.appendChild(top);
    shell.appendChild(main);
    shell.appendChild(ui.foot);
    root.appendChild(shell);

    ui.controls = [ui.playBtn, ui.slider, ui.decadeSel, ui.clearBtn].concat(ui.magBtns, ui.depthBtns);
    ui.controls.forEach(function (c) { c.disabled = true; });
    showDetail();
  }

  function showStatus(msg, isError) {
    ui.status.textContent = msg;
    ui.status.className = 'status' + (isError ? ' error' : '');
  }

  function hideStatus() {
    ui.status.className = 'status hidden';
  }

  // ---------- derived numbers and text ----------

  function passes(q) {
    return q.y <= state.year && q.mag >= state.minMag && state.depthOn[depthClass(q.depth)] &&
      (state.decade === null || Math.floor(q.y / 10) * 10 === state.decade);
  }

  function dropHiddenSelection() {
    if (state.selected && !passes(state.selected)) { state.selected = null; showDetail(); }
  }

  function setDepth(k) {
    var onCount = state.depthOn.filter(Boolean).length;
    // Never allow all three to be switched off: keep at least one visible.
    if (state.depthOn[k] && onCount === 1) { return; }
    state.depthOn[k] = !state.depthOn[k];
    ui.depthBtns[k].setAttribute('aria-pressed', state.depthOn[k] ? 'true' : 'false');
    dropHiddenSelection();
    rebuildDecades();
    refreshStats();
    dirty = true;
  }

  function setColorBy(mode) {
    state.colorBy = mode;
    ui.colorBtns.forEach(function (b, k) {
      b.setAttribute('aria-pressed', ['depth', 'mag'][k] === mode ? 'true' : 'false');
    });
    // When color shows magnitude, the depth chips are plain filters, so their dots go neutral.
    ui.depthDots.forEach(function (d, k) { d.style.background = mode === 'mag' ? NEUTRAL : DEPTH_COLORS[k]; });
    ui.magLegend.hidden = mode !== 'mag';
    dirty = true;
  }

  function resetFilters() {
    stopPlay();
    state.depthOn = [true, true, true];
    ui.depthBtns.forEach(function (b) { b.setAttribute('aria-pressed', 'true'); });
    state.decade = null;
    state.yearBeforeDecade = null;
    ui.decadeSel.value = 'all';
    setMinMag(6);
    setYear(LAST_YEAR);
    dirty = true;
  }

  function setDecade(d) {
    var wasAll = state.decade === null;
    if (wasAll && d !== null) { state.yearBeforeDecade = state.year; }
    state.decade = d;
    ui.decadeSel.value = d === null ? 'all' : String(d);
    if (d === null && !wasAll && state.yearBeforeDecade) {
      // Leaving the decade view restores the year the person had chosen before.
      setYear(state.yearBeforeDecade);
    }
    if (d !== null) {
      stopPlay();
      // Show the whole decade: move the year to its end (or today for the current decade).
      setYear(Math.min(LAST_YEAR, d + 9));
    }
    dropHiddenSelection();
    paintDecades();
    refreshStats();
    dirty = true;
  }

  function refreshStats() {
    var n = 0;
    var m8 = 0;
    var shallow = 0;
    var big = null;
    var qs = state.quakes;
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      if (!passes(q)) { continue; }
      n++;
      if (q.mag >= 8) { m8++; }
      if (q.depth < 70) { shallow++; }
      if (!big || q.mag > big.mag) { big = q; }
    }
    ui.statShown.textContent = fmt(n);
    ui.statM8.textContent = fmt(m8);
    ui.statBig.textContent = big ? 'M' + big.mag.toFixed(1) : '-';

    if (!n) {
      ui.title.textContent = 'No earthquakes of this size are recorded by this year';
      ui.sub.textContent = 'Move the year slider forward or lower the magnitude filter.';
      return;
    }
    var lead = state.year >= LAST_YEAR ? '' : 'By ' + state.year + ', ';
    var scope = ' since 1900';
    if (state.decade !== null) { lead = 'In the ' + state.decade + 's, '; scope = ''; }
    var depthNote = state.depthOn.every(Boolean) ? '' : ' (depth filter on)';
    ui.title.textContent = lead + fmt(n) + ' earthquakes of magnitude ' + state.minMag +
      '+' + scope + (state.depthOn.every(Boolean) && state.decade === null
        ? ' draw the map of Earth’s fault lines' : depthNote);
    var pct = Math.round(100 * shallow / n);
    ui.sub.textContent = 'Strongest so far: M' + big.mag.toFixed(1) + ', ' +
      (big.place || 'location not named') + ' (' + big.y + '). ' +
      pct + '% of these struck at shallow depth, under 70 km.';
  }

  function rebuildDecades() {
    var counts = {};
    var d;
    for (d = FIRST_YEAR; d <= LAST_YEAR; d += 10) { counts[d] = 0; }
    state.quakes.forEach(function (q) {
      if (q.mag >= state.minMag && state.depthOn[depthClass(q.depth)]) {
        var dec = Math.floor(q.y / 10) * 10;
        counts[dec] = (counts[dec] || 0) + 1;
      }
    });
    var decs = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    var max = 1;
    decs.forEach(function (k) { if (counts[k] > max) { max = counts[k]; } });

    ui.decades.textContent = '';
    decadeBars = [];
    var left = 6;
    var width = 288;
    var step = width / decs.length;
    var base = 54;
    var tall = 44;
    decs.forEach(function (dec, k) {
      var bh = Math.max(1, Math.round(tall * counts[dec] / max));
      var rect = svgEl('rect', {
        x: String(left + k * step + 1), y: String(base - bh),
        width: String(Math.max(2, step - 2)), height: String(bh), rx: '1.5', 'class': 'bar on'
      });
      var tip = svgEl('title', {});
      tip.textContent = dec + 's: ' + fmt(counts[dec]) + ' earthquakes';
      rect.appendChild(tip);
      rect.style.cursor = 'pointer';
      rect.setAttribute('tabindex', '0');
      rect.setAttribute('role', 'button');
      rect.setAttribute('aria-label', 'Filter to the ' + dec + 's, ' + fmt(counts[dec]) + ' earthquakes');
      (function (d) {
        function toggle() { setDecade(state.decade === d ? null : d); }
        rect.addEventListener('click', toggle);
        rect.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      })(dec);
      ui.decades.appendChild(rect);
      decadeBars.push({ dec: dec, rect: rect });
      if (k % 3 === 0) {
        var label = svgEl('text', { x: String(left + k * step), y: '67', 'class': 'axis-label' });
        label.textContent = String(dec);
        ui.decades.appendChild(label);
      }
    });
    paintDecades();
  }

  function paintDecades() {
    var cur = Math.floor(state.year / 10) * 10;
    decadeBars.forEach(function (b) {
      var on = state.decade === null ? b.dec <= cur : b.dec === state.decade;
      b.rect.setAttribute('class', on ? 'bar on' : 'bar off');
    });
  }

  function showDetail() {
    var q = state.selected;
    ui.detailBody.textContent = '';
    if (!q) {
      ui.detailBody.appendChild(h('p', 'muted', 'Click a point on the globe to see its date, depth and location.'));
      return;
    }
    var head = h('div', 'detail-head');
    head.appendChild(h('span', 'detail-mag', 'M' + q.mag.toFixed(1)));
    head.appendChild(h('span', 'detail-meta', q.t.slice(0, 10) + ' UTC'));
    ui.detailBody.appendChild(head);
    ui.detailBody.appendChild(h('p', 'detail-place', q.place || 'Location not named'));
    ui.detailBody.appendChild(h('p', 'detail-id', 'Depth ' + Math.round(q.depth) + ' km \u00b7 USGS ID ' + q.id));
  }

  // ---------- state changes ----------

  function setYear(y) {
    state.year = clamp(y, FIRST_YEAR, LAST_YEAR);
    ui.slider.value = String(state.year);
    ui.yearLabel.textContent = String(state.year);
    ui.yearBadge.textContent = String(state.year);
    if (state.selected && !passes(state.selected)) { state.selected = null; showDetail(); }
    refreshStats();
    paintDecades();
    dirty = true;
  }

  function setMinMag(m) {
    state.minMag = m;
    ui.magBtns.forEach(function (b, k) { b.setAttribute('aria-pressed', [6, 7, 8][k] === m ? 'true' : 'false'); });
    if (state.selected && !passes(state.selected)) { state.selected = null; showDetail(); }
    rebuildDecades();
    refreshStats();
    dirty = true;
  }

  function stopPlay() {
    state.playing = false;
    ui.playBtn.textContent = 'Play';
  }

  function togglePlay() {
    if (state.playing) { stopPlay(); return; }
    if (state.year >= LAST_YEAR) { setYear(FIRST_YEAR); }
    state.playing = true;
    ui.playBtn.textContent = 'Pause';
  }

  function setSpin(on) {
    state.spinning = on;
    ui.spinBtn.textContent = on ? 'Pause spin' : 'Resume spin';
  }

  function resetView() {
    state.rot = [HOME_ROTATION[0], HOME_ROTATION[1]];
    state.zoom = 1;
    dirty = true;
  }

  // ---------- drawing ----------

  function resize() {
    var rect = ui.stage.getBoundingClientRect();
    W = Math.max(240, Math.floor(rect.width));
    H = Math.max(240, Math.floor(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ui.canvas.width = Math.floor(W * dpr);
    ui.canvas.height = Math.floor(H * dpr);
    ui.canvas.style.width = W + 'px';
    ui.canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  function updateProjection() {
    var base = Math.min(W, H) / 2 - 14;
    projection.scale(base * state.zoom).translate([W / 2, H / 2]).rotate([state.rot[0], state.rot[1], 0]);
  }

  function isFront(q, center) {
    return G.geoDistance([q.lon, q.lat], center) <= HALF_PI;
  }

  function draw() {
    updateProjection();
    ctx.clearRect(0, 0, W, H);
    var sc = projection.scale();

    var grad = ctx.createRadialGradient(W / 2 - sc * 0.35, H / 2 - sc * 0.35, sc * 0.1, W / 2, H / 2, sc);
    grad.addColorStop(0, '#17305a');
    grad.addColorStop(1, '#0a1329');
    ctx.beginPath();
    pathGen({ type: 'Sphere' });
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pathGen(graticule);
    ctx.strokeStyle = 'rgba(140, 170, 220, 0.13)';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    ctx.beginPath();
    pathGen(G.land);
    ctx.fillStyle = '#23375f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(170, 195, 235, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Country borders (shared boundaries only; coastlines are the land outline above).
    if (G.borders) {
      ctx.beginPath();
      pathGen(G.borders);
      ctx.strokeStyle = 'rgba(190, 210, 245, 0.4)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    var rot = projection.rotate();
    var center = [-rot[0], -rot[1]];
    var qs = state.quakes;
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      if (!passes(q) || !isFront(q, center)) { continue; }
      var p = projection([q.lon, q.lat]);
      if (!p) { continue; }
      var age = state.year - q.y;
      ctx.globalAlpha = age === 0 ? 1 : Math.max(0.2, 1 - age / 45);
      ctx.fillStyle = colorFor(q);
      var r = dotRadius(q.mag);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, 6.2832);
      ctx.fill();
      if (age === 0 && state.year < LAST_YEAR) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r + 2.5, 0, 6.2832);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    var s = state.selected;
    if (s && passes(s) && isFront(s, center)) {
      var sp = projection([s.lon, s.lat]);
      if (sp) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sp[0], sp[1], dotRadius(s.mag) + 5, 0, 6.2832);
        ctx.stroke();
      }
    }

    ctx.beginPath();
    pathGen({ type: 'Sphere' });
    ctx.strokeStyle = 'rgba(160, 190, 240, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // ---------- interaction ----------

  function pick(e) {
    var rect = ui.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var rot = projection.rotate();
    var center = [-rot[0], -rot[1]];
    var best = null;
    var bestD = 1e9;
    var qs = state.quakes;
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      if (!passes(q) || !isFront(q, center)) { continue; }
      var p = projection([q.lon, q.lat]);
      if (!p) { continue; }
      var d = Math.sqrt((p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y));
      if (d < dotRadius(q.mag) + 5 && d < bestD) { bestD = d; best = q; }
    }
    state.selected = best;
    showDetail();
    dirty = true;
  }

  function wireEvents() {
    ui.canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      moved = false;
      dragLast = [e.clientX, e.clientY];
      dragStart = [e.clientX, e.clientY];
      try { ui.canvas.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
      if (state.spinning) { setSpin(false); }
    });
    ui.canvas.addEventListener('pointermove', function (e) {
      if (!dragging) { return; }
      var sens = 0.3 / state.zoom;
      state.rot[0] += (e.clientX - dragLast[0]) * sens;
      state.rot[1] = clamp(state.rot[1] - (e.clientY - dragLast[1]) * sens, -90, 90);
      dragLast = [e.clientX, e.clientY];
      if (Math.abs(e.clientX - dragStart[0]) + Math.abs(e.clientY - dragStart[1]) > 4) { moved = true; }
      dirty = true;
    });
    function endDrag(e) {
      if (!dragging) { return; }
      dragging = false;
      if (!moved && state.loaded && e.type === 'pointerup') { pick(e); }
    }
    ui.canvas.addEventListener('pointerup', endDrag);
    ui.canvas.addEventListener('pointercancel', endDrag);
    ui.canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0015), 0.8, 5);
      dirty = true;
    }, { passive: false });

    ui.playBtn.addEventListener('click', togglePlay);
    ui.slider.addEventListener('input', function () {
      stopPlay();
      setYear(parseInt(ui.slider.value, 10));
    });
    ui.spinBtn.addEventListener('click', function () { setSpin(!state.spinning); });
    ui.resetBtn.addEventListener('click', resetView);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize).observe(ui.stage);
    } else {
      window.addEventListener('resize', resize);
    }
  }

  var lastTs = 0;
  var acc = 0;
  function frame(ts) {
    window.requestAnimationFrame(frame);
    var dt = Math.min(100, ts - lastTs);
    lastTs = ts;
    if (state.spinning && !dragging) { state.rot[0] += dt * 0.006; dirty = true; }
    if (state.playing) {
      acc += dt;
      if (acc > 140) {
        acc = 0;
        if (state.year < LAST_YEAR) { setYear(state.year + 1); } else { stopPlay(); }
      }
    }
    if (dirty) { dirty = false; draw(); }
  }

  // ---------- data loading ----------

  function onLoaded() {
    state.loaded = true;
    hideStatus();
    ui.controls.forEach(function (c) { c.disabled = false; });
    setYear(LAST_YEAR);
    rebuildDecades();
    refreshStats();
    showDetail();
    ui.foot.textContent = 'Source: USGS Earthquake Hazards Program catalog, earthquakes of magnitude 6 and above from 1900 to today. ' +
      fmt(state.quakes.length) + ' events loaded ' + state.loadedAt.toLocaleString() +
      (state.skipped ? ' (' + state.skipped + ' rows skipped for missing values)' : '') +
      '. Map data: Natural Earth. Created by Waqar Ahmed Shaikh.';
    dirty = true;
  }

  function load() {
    showStatus('Loading earthquakes from USGS...', false);
    var timer = null;
    var abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (abort) { abort.abort(); }
        reject(new Error('The request took longer than 60 seconds.'));
      }, 60000);
    });
    var request = fetch(dataUrl(), abort ? { signal: abort.signal } : undefined).then(function (resp) {
      if (!resp.ok) { throw new Error('USGS answered with HTTP ' + resp.status + '.'); }
      return resp.text();
    });
    Promise.race([request, timeout]).then(function (text) {
      clearTimeout(timer);
      var rows = parseCsv(text);
      if (rows.length < 2) { throw new Error('The catalog returned no rows.'); }
      var parsed = toQuakes(rows);
      if (!parsed.quakes.length) { throw new Error('No usable earthquake rows were found.'); }
      state.quakes = parsed.quakes;
      state.skipped = parsed.skipped;
      state.loadedAt = new Date();
      onLoaded();
    }).catch(function (err) {
      clearTimeout(timer);
      showStatus(state.blockedMsg ||
        ('Could not load the earthquake catalog. ' + ((err && err.message) || String(err))), true);
    });
  }

  // ---------- boot ----------

  document.addEventListener('securitypolicyviolation', function (e) {
    state.blockedMsg = 'Blocked by the site policy: ' + e.blockedURI + ' (' + e.violatedDirective +
      '). The page could not reach earthquake.usgs.gov.';
    if (ui.status) { showStatus(state.blockedMsg, true); }
  });

  function boot() {
    if (!root) { return; }
    if (!G || !G.geoOrthographic) {
      root.textContent = '';
      var p = h('p', 'status error', 'The globe library did not load, so the app cannot draw.');
      root.appendChild(p);
      return;
    }
    // Render first, initialize second.
    buildShell();
    ctx = ui.canvas.getContext('2d');
    projection = G.geoOrthographic().clipAngle(90).precision(0.5);
    pathGen = G.geoPath(projection, ctx);
    graticule = G.geoGraticule10();
    wireEvents();
    resize();
    window.requestAnimationFrame(frame);
    load();
    try {
      if (window.tableau && window.tableau.extensions && window.tableau.extensions.initializeAsync) {
        window.tableau.extensions.initializeAsync().catch(function () { /* the app does not need workbook data */ });
      }
    } catch (err) { /* ignore: rendering does not depend on the Extensions API */ }
  }

  boot();
})();
