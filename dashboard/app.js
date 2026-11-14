// Token Radar v2 dashboard: board, filter, sort and detail view. No network, no fetch:
// the data arrives as window.RADAR from ../data.js, written by main.ts from the snapshot.
(function () {
  'use strict';
  var data = window.RADAR;
  if (!data || !Array.isArray(data.rows)) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="7">No radar data. Run main.ts to write data.js.</td></tr>';
    return;
  }
  var rows = data.rows;

  /** Escape text for HTML. */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** $682,875,166 -> $682.9M; $764,682 -> $764.7K. */
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  /** +2.37 -> +2.4%; null -> em dash. */
  function pct(v) {
    if (v === null || v === undefined) return '<span class="num">&mdash;</span>';
    var cls = v >= 0 ? 'pos' : 'neg';
    return '<span class="num ' + cls + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }

  /** Days since listing -> 1.1y, 8mo, 42d, or an em dash when unlisted. */
  function ageLabel(days) {
    if (days === null || days === undefined) return '&mdash;';
    if (days >= 365) return (days / 365.25).toFixed(1) + 'y';
    if (days >= 30) return Math.round(days / 30) + 'mo';
    return days + 'd';
  }

  // ---- header stats -------------------------------------------------------
  var top = rows[0];
  document.getElementById('stats').innerHTML =
    '<div><dt>Board rows</dt><dd>' + rows.length + '</dd></div>' +
    '<div><dt>Watchlist</dt><dd>' + data.watchlist_size + ' / 40</dd></div>' +
    '<div><dt>Token trades</dt><dd class="warn">' + data.flagged_size + ' flagged</dd></div>' +
    '<div><dt>Top implied</dt><dd>' + money(top.implied_value_usd) + '</dd></div>';

  // ---- category filter ----------------------------------------------------
  var cats = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category);
  });
  cats.sort();
  var catSel = document.getElementById('cat');
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    catSel.appendChild(o);
  });

  // ---- state from the URL hash (so a view can be linked and screenshotted) -
  var qEl = document.getElementById('q');
  var statusEl = document.getElementById('status');
  var watchEl = document.getElementById('watch');
  var sortEl = document.getElementById('sort');
  var selectedSlug = null;
  (location.hash || '').slice(1).split('&').forEach(function (pair) {
    var kv = pair.split('=');
    var k = decodeURIComponent(kv[0] || '');
    var v = decodeURIComponent(kv[1] || '');
    if (k === 'q') qEl.value = v;
    if (k === 'cat') catSel.value = v;
    if (k === 'status') statusEl.value = v;
    if (k === 'watch') watchEl.checked = v === '1';
    if (k === 'sort') sortEl.value = v;
    if (k === 'slug') selectedSlug = v;
  });

  // ---- board rendering ----------------------------------------------------
  var tbody = document.getElementById('rows');
  var countEl = document.getElementById('count');

  function filtered() {
    var q = qEl.value.trim().toLowerCase();
    var cat = catSel.value;
    var status = statusEl.value;
    var watchOnly = watchEl.checked;
    var list = rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      if (cat && r.category !== cat) return false;
      if (status && r.token_status !== status) return false;
      if (watchOnly && !r.watchlist) return false;
      return true;
    });
    var sort = sortEl.value;
    list = list.slice();
    if (sort === 'tvl') list.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (sort === 'growth') list.sort(function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); });
    else if (sort === 'age') list.sort(function (a, b) { return (b.age_days || 0) - (a.age_days || 0); });
    else list.sort(function (a, b) { return a.rank - b.rank; });
    return list;
  }

  // The watchlist is the 40 rows the snapshot names; the board carries them all,
  // and the page marks them from the data itself (watchlist flag on each row).
  function badge(r) {
    if (r.token_status === 'token_trades') return '<span class="badge warn">TOKEN TRADES</span>';
    return '<span class="badge ok">PRE-TOKEN</span>';
  }

  function render() {
    var list = filtered();
    var html = '';
    list.forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '" class="' + (r.token_status === 'token_trades' ? 'flagged' : '') + (selectedSlug === r.slug ? ' selected' : '') + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td>' + pct(r.change_7d) + '</td>' +
        '<td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td>' +
        '<td>' + badge(r) + '</td></tr>';
    });
    tbody.innerHTML = html || '<tr><td colspan="7">Nothing matches these filters.</td></tr>';
    countEl.textContent = list.length + ' of ' + rows.length + ' rows';
  }

  tbody.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-slug]');
    if (!tr) return;
    select(tr.getAttribute('data-slug'), true);
  });

  // ---- detail view ---------------------------------------------------------
  var detailEl = document.getElementById('detail');

  function select(slug, scroll) {
    selectedSlug = slug;
    var r = null;
    rows.forEach(function (row) { if (row.slug === slug) r = row; });
    if (!r) return;
    var base = r.tvl_usd * r.multiple;
    var noteHtml = '';
    if (r.token_status === 'token_trades') {
      noteHtml = '<div class="note"><strong>Token already trades.</strong> ' + esc(r.token_note || '') + '</div>';
    } else if (r.token_note) {
      noteHtml = '<div class="note info"><strong>Note.</strong> ' + esc(r.token_note) + '</div>';
    }
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    detailEl.innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' &middot; ' + esc(r.category || 'Uncategorised') + ' &middot; ' + esc(r.slug) + '</p>' +
      '<p class="big">' + money(r.implied_value_usd) + '</p>' +
      '<p class="big-label">Implied value if it launches a token</p>' +
      noteHtml +
      '<table class="model">' +
      '<tr><td>TVL</td><td>' + money(r.tvl_usd) + '</td></tr>' +
      '<tr><td>&times; category multiple</td><td>' + r.multiple.toFixed(4) + '</td></tr>' +
      '<tr><td>&times; growth (' + (r.change_7d === null ? 'n/a' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '% / 7d') + ')</td><td>' + r.growth_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td>&times; age (' + ageLabel(r.age_days) + ' listed)</td><td>' + r.age_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td>&times; chains (' + r.chains.length + ')</td><td>' + r.chains_multiplier.toFixed(4) + '</td></tr>' +
      '<tr class="total"><td>= implied value</td><td>' + money(r.implied_value_usd) + '</td></tr>' +
      '</table>' +
      '<h3>How to farm it</h3><ol>' + steps + '</ol>' +
      '<p class="meta">Chains: <b>' + esc(r.chains.join(', ') || '—') + '</b><br>Listed: <b>' + esc(r.listed_at || 'not recorded') + '</b> &middot; Snapshot: <b>' + esc(data.as_of) + '</b></p>';
    render();
    if (scroll) detailEl.scrollIntoView({ block: 'nearest' });
  }

  // ---- corrections ---------------------------------------------------------
  var exclEl = document.getElementById('excluded');
  exclEl.innerHTML = (data.excluded || []).map(function (e) {
    return '<li><b>' + esc(e.name) + '</b> &mdash; ' + esc(e.evidence) + '</li>';
  }).join('');

  [qEl, catSel, statusEl, watchEl, sortEl].forEach(function (el) {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });

  render();
  if (selectedSlug) select(selectedSlug, false);
  else select(rows[0].slug, false);
})();
