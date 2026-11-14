// Token Radar v3 — renders the board from ROWS (dashboard/data.js).
// ROWS columns: [slug, name, implied, tvl, change_7d, category, status,
// multiple, growth, age_factor, chains_factor, evidence, [steps x4], category_multiple_used]
const $ = (id) => document.getElementById(id);
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (n) => (n === null ? "–" : (n >= 0 ? "+" : "") + n.toFixed(1) + "%");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function parseHash() {
  const out = {};
  for (const part of location.hash.slice(1).split("&")) {
    const [k, v] = part.split("=");
    if (k) out[k] = decodeURIComponent(v || "");
  }
  return out;
}

function rows() {
  const h = parseHash();
  const q = ($("q").value || "").toLowerCase();
  const cat = $("cat").value;
  const status = $("status").value;
  const watchOnly = $("watch").checked;
  let list = ROWS.map((r, i) => ({ r, i }));
  if (q) list = list.filter(({ r }) => r[1].toLowerCase().includes(q) || r[0].includes(q));
  if (cat) list = list.filter(({ r }) => r[5] === cat);
  if (status !== "") list = list.filter(({ r }) => String(r[6]) === status);
  if (watchOnly) list = list.filter(({ r }) => WATCH.has(r[0]));
  const key = $("sort").value;
  const val = (a) => (key === "value" ? a.r[2] : key === "tvl" ? a.r[3] : key === "chg" ? (a.r[4] ?? -1e9) : key === "age" ? a.r[9] : a.r[1]);
  list.sort((a, b) => (key === "name" ? String(val(a)).localeCompare(String(val(b))) : val(b) - val(a)));
  return list;
}

function renderBoard() {
  const list = rows();
  $("rows").innerHTML = list.map(({ r, i }) => {
    const flag = r[6] === 1 ? '<span class="badge">TOKEN TRADES</span>' : "";
    return `<tr data-slug="${r[0]}"><td>${i + 1}</td>` +
      `<td>${esc(r[1])}${flag}</td><td>${esc(r[5])}</td>` +
      `<td class="num">${money(r[3])}</td><td class="num">${pct(r[4])}</td>` +
      `<td class="num"><b>${money(r[2])}</b></td></tr>`;
  }).join("");
  $("count").textContent = list.length + " of " + ROWS.length + " rows shown";
  document.querySelectorAll("#rows tr").forEach((tr) => {
    tr.addEventListener("click", () => { location.hash = "#slug=" + tr.dataset.slug; });
  });
}

function renderDetail(slug) {
  const r = ROWS.find((x) => x[0] === slug);
  const board = $("board-wrap"), det = $("detail");
  if (!r) { board.hidden = false; det.hidden = true; return; }
  board.hidden = true; det.hidden = false;
  const years = Math.exp((r[9] - 1) / 0.08) - 1;
  const chains = Math.round((r[10] - 1) / 0.02);
  const ev = r[6] === 1 ? `<div class="ev"><b>Token already trades.</b> ${esc(r[11])}</div>` : "";
  det.innerHTML =
    `<a class="back" href="#">&larr; Back to the board</a>` +
    `<h2>${esc(r[1])}${r[6] === 1 ? ' <span class="badge">TOKEN TRADES</span>' : ""}</h2>` +
    `<p class="sub">Rank ${ROWS.indexOf(r) + 1} of ${ROWS.length} · ${esc(r[5])} · ${r[6] === 1 ? "token already trades" : "records no token"}${WATCH.has(r[0]) ? " · on the watchlist" : ""}</p>` +
    ev +
    `<h3>Model breakdown</h3><table><tbody>` +
    `<tr><td>TVL</td><td class="num">${money(r[3])}</td></tr>` +
    `<tr><td>× multiple (${r[13] ? "category median mcap/TVL" : "overall median 0.214"})</td><td class="num">${r[7]}</td></tr>` +
    `<tr><td>× growth (7d ${pct(r[4])} damped by half, clamped)</td><td class="num">${r[8]}</td></tr>` +
    `<tr><td>× age (${years.toFixed(1)} years listed)</td><td class="num">${r[9]}</td></tr>` +
    `<tr><td>× chains (${chains} chain${chains === 1 ? "" : "s"})</td><td class="num">${r[10]}</td></tr>` +
    `<tr class="total"><td>Implied value</td><td class="num">${money(r[2])}</td></tr>` +
    `</tbody></table>` +
    `<h3>Farm plan</h3><ol>${r[12].map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
}

function applyHash() {
  const h = parseHash();
  if (h.q !== undefined) $("q").value = h.q;
  if (h.cat !== undefined) $("cat").value = h.cat;
  if (h.status !== undefined) $("status").value = h.status;
  if (h.sort !== undefined) $("sort").value = h.sort;
  $("watch").checked = h.watch === "1";
  if (h.slug) renderDetail(h.slug); else { $("board-wrap").hidden = false; $("detail").hidden = true; renderBoard(); }
}

function syncHash() {
  const parts = [];
  if ($("q").value) parts.push("q=" + encodeURIComponent($("q").value));
  if ($("cat").value) parts.push("cat=" + encodeURIComponent($("cat").value));
  if ($("status").value) parts.push("status=" + $("status").value);
  if ($("watch").checked) parts.push("watch=1");
  if ($("sort").value !== "value") parts.push("sort=" + $("sort").value);
  history.replaceState(null, "", parts.length ? "#" + parts.join("&") : "#");
  renderBoard();
}

// Watchlist membership comes from WATCHLIST in data.js (a top-level const,
// so it is a global lexical binding, not a property of window).
const WATCH = new Set(typeof WATCHLIST !== "undefined" ? WATCHLIST : []);

(function init() {
  const cats = [...new Set(ROWS.map((r) => r[5]))].sort();
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c; $("cat").appendChild(opt);
  }
  const flagged = ROWS.filter((r) => r[6] === 1).length;
  $("st-rows").textContent = ROWS.length;
  $("st-watch").textContent = WATCH.size + "/40";
  $("st-flag").textContent = flagged;
  $("st-top").textContent = money(ROWS[0][2]);
  for (const id of ["q", "cat", "status", "watch", "sort"]) {
    $(id).addEventListener("input", syncHash);
  }
  document.querySelectorAll("th[data-k]").forEach((th) => {
    th.addEventListener("click", () => {
      const map = { rank: "value", name: "name", cat: "name", tvl: "tvl", chg: "chg", value: "value" };
      $("sort").value = map[th.dataset.k] || "value";
      syncHash();
    });
  });
  window.addEventListener("hashchange", applyHash);
  applyHash();
})();
