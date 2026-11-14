// Token Radar dashboard: renders the board from window.RADAR (data.js),
// with search, category/chain filters, watchlist toggle, sorting and a
// detail view per protocol. No network: all data is local, all rendering
// happens from the snapshot the program already ranked.
(function () {
  var D = window.RADAR;
  var rows = D.rows;
  var asOf = new Date(D.asOf + "T00:00:00Z");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
    return "$" + Math.round(n);
  }
  function ageYears(a) {
    if (!a) return null;
    return (asOf - new Date(a + "T00:00:00Z")) / 86400000 / 365.25;
  }
  function ageStr(a) {
    var y = ageYears(a);
    if (y == null) return "—";
    if (y < 1) return Math.round(y * 12) + "mo";
    return y.toFixed(1) + "y";
  }
  function chgStr(g) {
    if (g == null) return '<span class="sub">—</span>';
    var cls = g >= 0 ? "up" : "down";
    return '<span class="' + cls + '">' + (g >= 0 ? "+" : "") + g.toFixed(1) + "%</span>";
  }
  function bookFor(cat) { return D.catBook[cat] || "other"; }
  function stepsFor(r) {
    var chain = r.h[0] || "Ethereum";
    return D.playbooks[bookFor(r.c)].map(function (t) {
      return t.split("{name}").join(r.n).split("{chain}").join(chain);
    });
  }
  function catRank(r) {
    var same = rows.filter(function (x) { return x.c === r.c; });
    same.sort(function (a, b) { return b.v - a.v; });
    return same.findIndex(function (x) { return x.s === r.s; }) + 1;
  }
  function whyFor(r) {
    var n = rows.filter(function (x) { return x.c === r.c; }).length;
    var g = r.g == null ? "no 7-day change reported" : (r.g >= 0 ? "up " + r.g.toFixed(1) + "% in 7 days" : "down " + Math.abs(r.g).toFixed(1) + "% in 7 days");
    var a = ageYears(r.a);
    var age = a == null ? "an unreported age" : (a < 1 ? Math.round(a * 12) + " months" : a.toFixed(1) + " years");
    return "No. " + catRank(r) + " of " + n + " " + (r.c || "uncategorised") + " protocols by implied value. " +
      money(r.t) + " TVL, " + g + ", running " + age + " with no token recorded — " +
      "scale first, momentum second, staying power third.";
  }

  // ---- header meta ----
  document.getElementById("meta").innerHTML =
    "<b>" + D.count + " protocols ranked</b><br>" + D.watchlist + " on the house watchlist · " +
    money(D.floor) + " floor<br>snapshot " + esc(D.asOf) + " · DefiLlama";

  // ---- filters ----
  var catSel = document.getElementById("cat");
  var chainSel = document.getElementById("chain");
  var cats = [...new Set(rows.map(function (r) { return r.c; }))].sort();
  catSel.innerHTML = '<option value="">All categories</option>' + cats.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
  }).join("");
  var chains = [...new Set(rows.flatMap(function (r) { return r.h; }))].sort();
  chainSel.innerHTML = '<option value="">All chains</option>' + chains.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
  }).join("");

  var state = { q: "", cat: "", chain: "", wl: false, sort: "v", sel: null };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (q && r.n.toLowerCase().indexOf(q) < 0 && r.s.toLowerCase().indexOf(q) < 0) return false;
      if (state.cat && r.c !== state.cat) return false;
      if (state.chain && r.h.indexOf(state.chain) < 0) return false;
      if (state.wl && !r.w) return false;
      return true;
    });
    var by = {
      v: function (a, b) { return b.v - a.v; },
      t: function (a, b) { return b.t - a.t; },
      g: function (a, b) { return (b.g == null ? -1e9 : b.g) - (a.g == null ? -1e9 : a.g); },
      a: function (a, b) { return (ageYears(b.a) || -1) - (ageYears(a.a) || -1); },
    }[state.sort];
    out.sort(by);
    return out;
  }

  function render() {
    var list = filtered();
    document.getElementById("count").textContent = list.length + " of " + rows.length + " shown";
    var tb = document.getElementById("rows");
    tb.innerHTML = list.map(function (r) {
      var idx = rows.indexOf(r) + 1;
      return '<tr data-slug="' + esc(r.s) + '" class="' + (state.sel === r.s ? "sel" : "") + '">' +
        '<td class="num">' + idx + "</td>" +
        '<td><span class="nm">' + esc(r.n) + "</span>" +
        (r.w ? ' <span class="wl">★ WATCHLIST</span>' : "") +
        '<br><span class="sub">' + esc(r.s) + "</span></td>" +
        '<td><span class="pill">' + esc(r.c || "—") + "</span></td>" +
        "<td>" + esc(r.h.slice(0, 3).join(", ")) + (r.h.length > 3 ? " +" + (r.h.length - 3) : "") + "</td>" +
        '<td class="num">' + money(r.t) + "</td>" +
        '<td class="num">' + chgStr(r.g) + "</td>" +
        '<td class="num">' + ageStr(r.a) + "</td>" +
        '<td class="num"><b>' + money(r.v) + "</b></td>" +
        '<td class="bar"><i style="width:' + r.sc + '%"></i><b>' + r.sc + "/100</b></td></tr>";
    }).join("");
    tb.querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function () { select(tr.getAttribute("data-slug")); });
    });
  }

  function select(slug) {
    state.sel = slug;
    var r = rows.find(function (x) { return x.s === slug; });
    var box = document.getElementById("detail");
    if (!r) { box.hidden = true; render(); return; }
    var idx = rows.indexOf(r) + 1;
    var steps = stepsFor(r).map(function (s, i) {
      return "<li><b>Step " + (i + 1) + ".</b> " + esc(s) + "</li>";
    }).join("");
    var mult = r.m.toFixed(2);
    var multLabel = r.f
      ? "median mcap/TVL of " + esc(r.c || "all") + " protocols with a token"
      : "overall median mcap/TVL across token-bearing protocols (too few in this category for a category median)";
    var growthF = (1 + 0.5 * (Math.min(100, Math.max(-30, r.g == null ? 0 : r.g)) / 100)).toFixed(2);
    var y = ageYears(r.a);
    var ageF = (1 + 0.08 * Math.log(1 + Math.min(Math.max(y == null ? 1 : y, 0), 5))).toFixed(2);
    var chainF = (1 + 0.02 * Math.min(Math.max(r.h.length - 1, 0), 4)).toFixed(2);
    document.getElementById("detailBody").innerHTML =
      "<h2>" + esc(r.n) + "</h2>" +
      '<div class="cat">' + esc(r.c || "—") + " · " + esc(r.h.join(", ")) + (r.w ? ' · <span class="wl">★ ON THE HOUSE WATCHLIST</span>' : "") + "</div>" +
      '<div class="big">' + money(r.v) + '</div><p class="bigsub">implied launch value · rank #' + idx + " of " + rows.length + "</p>" +
      '<div class="kv">' +
      "<div><div class=k>TVL</div><div class=v>" + money(r.t) + "</div></div>" +
      "<div><div class=k>7-DAY CHANGE</div><div class=v>" + (r.g == null ? "—" : (r.g >= 0 ? "+" : "") + r.g.toFixed(1) + "%") + "</div></div>" +
      "<div><div class=k>RUNNING</div><div class=v>" + ageStr(r.a) + "</div></div>" +
      "<div><div class=k>SCORE</div><div class=v>" + r.sc + " / 100</div></div>" +
      "</div>" +
      '<div class="why">' + esc(whyFor(r)) + "</div>" +
      "<h3>HOW TO FARM IT</h3><ol>" + steps + "</ol>" +
      "<h3>VALUE MODEL</h3>" +
      '<div class="formula">TVL <b>' + money(r.t) + "</b> × category multiple <b>" + mult + "</b> (" + multLabel +
      ") × growth <b>" + growthF + "</b> × age <b>" + ageF +
      "</b> × chains <b>" + chainF + "</b> = <b>" + money(r.v) + "</b>.<br>" +
      "This protocol records no token. That is the snapshot's record, not proof it has none.</div>";
    box.hidden = false;
    render();
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.getElementById("close").addEventListener("click", function () {
    state.sel = null;
    document.getElementById("detail").hidden = true;
    history.replaceState(null, "", location.pathname + location.search);
    render();
  });
  document.getElementById("q").addEventListener("input", function (e) { state.q = e.target.value; render(); });
  catSel.addEventListener("change", function (e) { state.cat = e.target.value; render(); });
  chainSel.addEventListener("change", function (e) { state.chain = e.target.value; render(); });
  document.getElementById("wl").addEventListener("change", function (e) { state.wl = e.target.checked; render(); });
  document.getElementById("sort").addEventListener("change", function (e) { state.sort = e.target.value; render(); });

  // Hash routing, so each screenshot view is a plain link: #detail=<slug>,
  // #cat=<category>, #wl=1.
  function fromHash() {
    var h = new URLSearchParams(location.hash.slice(1));
    if (h.get("cat")) { state.cat = h.get("cat"); catSel.value = state.cat; }
    if (h.get("chain")) { state.chain = h.get("chain"); chainSel.value = state.chain; }
    if (h.get("wl") === "1") { state.wl = true; document.getElementById("wl").checked = true; }
    if (h.get("q")) { state.q = h.get("q"); document.getElementById("q").value = state.q; }
    render();
    if (h.get("detail")) select(h.get("detail"));
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();
