const FUSION_DATA_LOCAL = 'fusion-data.json';
const FUSION_DATA_REMOTE = 'https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/fusion-data.json';
const BAZAAR_URL = 'https://api.hypixel.net/v2/skyblock/bazaar';
const CORS_PROXY = 'https://corsproxy.io/?';
const REFRESH_MS = 60_000;

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

const state = {
  fusionData: null,
  flatRecipes: [],
  bazaar: {},
  lastUpdated: null,
  sortKey: 'insta_margin',
  sortDir: -1,
  refreshTimer: null,
};

const $ = (id) => document.getElementById(id);

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    const r = await fetch(CORS_PROXY + encodeURIComponent(url));
    if (!r.ok) throw new Error(`Proxy HTTP ${r.status}`);
    return await r.json();
  }
}

async function loadFusionData(url) {
  setStatus('Loading fusion data…');
  const data = await fetchJson(url);
  if (!data.recipes || !data.shards) throw new Error('Invalid fusion-data.json');
  state.fusionData = data;
  state.flatRecipes = buildFlatRecipes(data);
  setStatus(
    `Loaded ${state.flatRecipes.length} unique recipes across ${Object.keys(data.shards).length} shards`,
    'ok'
  );
}

function buildFlatRecipes(fusionData) {
  const flat = [];
  const seen = new Set();
  for (const [outputKey, qtyMap] of Object.entries(fusionData.recipes)) {
    for (const [qtyStr, pairs] of Object.entries(qtyMap)) {
      const outputQty = parseInt(qtyStr, 10);
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [a, b] = pair;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const key = `${outputKey}|${lo}|${hi}|${outputQty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        flat.push({ outputKey, outputQty, inputKeys: [a, b] });
      }
    }
  }
  return flat;
}

async function fetchBazaar() {
  setStatus('Fetching Bazaar…');
  const data = await fetchJson(BAZAAR_URL);
  if (!data.success) throw new Error('Bazaar API: success=false');
  state.bazaar = data.products;
  state.lastUpdated = data.lastUpdated;
  setStatus(
    `Bazaar OK — ${Object.keys(state.bazaar).length} products, updated ${new Date(state.lastUpdated).toLocaleTimeString()}`,
    'ok'
  );
}

function priceOf(internalId) {
  const p = state.bazaar[internalId];
  if (!p || !p.quick_status) return null;
  const q = p.quick_status;
  return {
    instaBuy: q.buyPrice,
    instaSell: q.sellPrice,
    orderBuy: q.sellPrice + 0.1,
    orderSell: q.buyPrice - 0.1,
    weekVol: q.sellMovingWeek,
  };
}

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (abs >= 10_000) return (n / 1_000).toFixed(1) + 'k';
  return Math.round(n).toLocaleString();
}

function fmtPct(n) {
  if (!isFinite(n)) return '-';
  return (n * 100).toFixed(1) + '%';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function calculate() {
  if (!state.fusionData || !Object.keys(state.bazaar).length) {
    render([]);
    return;
  }
  const tax = (parseFloat($('tax').value) || 0) / 100;
  const minMargin = parseFloat($('min-margin').value) || 0;
  const minVol = parseFloat($('min-volume').value) || 0;
  const topN = parseInt($('top-n').value, 10) || 200;
  const hideLoss = $('hide-loss').checked;
  const bestPerOutput = $('best-per-output').checked;
  const allowedRarities = new Set(
    Array.from(document.querySelectorAll('.rarity:checked')).map((el) => el.value)
  );
  const search = ($('search').value || '').trim().toLowerCase();

  const shards = state.fusionData.shards;
  const rows = [];

  for (const rec of state.flatRecipes) {
    const outShard = shards[rec.outputKey];
    if (!outShard) continue;
    if (!allowedRarities.has(outShard.rarity)) continue;
    if (search && !outShard.name.toLowerCase().includes(search)) continue;

    const outPrice = priceOf(outShard.internal_id);
    if (!outPrice) continue;
    if (outPrice.weekVol < minVol) continue;

    const inA = shards[rec.inputKeys[0]];
    const inB = shards[rec.inputKeys[1]];
    if (!inA || !inB) continue;
    const pA = priceOf(inA.internal_id);
    const pB = priceOf(inB.internal_id);
    if (!pA || !pB) continue;

    const instaCost = pA.instaBuy * inA.fuse_amount + pB.instaBuy * inB.fuse_amount;
    const orderCost = pA.orderBuy * inA.fuse_amount + pB.orderBuy * inB.fuse_amount;
    const instaRev = outPrice.instaSell * rec.outputQty * (1 - tax);
    const orderRev = outPrice.orderSell * rec.outputQty * (1 - tax);
    const instaMargin = instaRev - instaCost;
    const orderMargin = orderRev - orderCost;
    const instaRoi = instaCost > 0 ? instaMargin / instaCost : 0;
    const orderRoi = orderCost > 0 ? orderMargin / orderCost : 0;

    if (hideLoss && instaMargin < 0 && orderMargin < 0) continue;
    if (Math.max(instaMargin, orderMargin) < minMargin) continue;

    rows.push({
      outputKey: rec.outputKey,
      output_name: outShard.name,
      output_qty: rec.outputQty,
      rarity: outShard.rarity,
      recipe: `${inA.fuse_amount}× ${inA.name}  +  ${inB.fuse_amount}× ${inB.name}`,
      insta_cost: instaCost,
      insta_rev: instaRev,
      insta_margin: instaMargin,
      insta_roi: instaRoi,
      order_cost: orderCost,
      order_rev: orderRev,
      order_margin: orderMargin,
      order_roi: orderRoi,
      week_vol: outPrice.weekVol,
    });
  }

  let displayRows = rows;
  if (bestPerOutput) {
    const numericSort = state.sortKey !== 'output_name' && state.sortKey !== 'rarity';
    const metric = numericSort ? state.sortKey : 'insta_margin';
    const wantHigh = numericSort ? state.sortDir === -1 : true;
    const best = new Map();
    for (const r of rows) {
      const cur = best.get(r.outputKey);
      if (!cur || (wantHigh ? r[metric] > cur[metric] : r[metric] < cur[metric])) {
        best.set(r.outputKey, r);
      }
    }
    displayRows = Array.from(best.values());
  }

  const k = state.sortKey;
  displayRows.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === 'rarity') { av = RARITY_ORDER[av]; bv = RARITY_ORDER[bv]; }
    if (typeof av === 'string') return av.localeCompare(bv) * state.sortDir;
    return (av - bv) * state.sortDir;
  });

  const total = displayRows.length;
  displayRows = displayRows.slice(0, topN);
  render(displayRows, total);
}

function render(rows, total = 0) {
  const tbody = document.querySelector('#results tbody');
  const empty = $('empty-note');
  const rowCount = $('row-count');

  if (!state.fusionData) {
    empty.textContent = 'Loading fusion data…';
    empty.classList.remove('hidden');
    tbody.innerHTML = '';
    rowCount.textContent = '';
    return;
  }
  if (!rows.length) {
    empty.textContent = Object.keys(state.bazaar).length
      ? 'No recipes match the current filters.'
      : 'Waiting for Bazaar data…';
    empty.classList.remove('hidden');
    tbody.innerHTML = '';
    rowCount.textContent = '';
    return;
  }
  empty.classList.add('hidden');

  const parts = [];
  for (const r of rows) {
    parts.push(
      '<tr>',
      `<td>${r.output_qty}× ${escapeHtml(r.output_name)}</td>`,
      `<td class="rarity-${r.rarity}">${r.rarity}</td>`,
      `<td>${escapeHtml(r.recipe)}</td>`,
      `<td>${fmt(r.insta_cost)}</td>`,
      `<td>${fmt(r.insta_rev)}</td>`,
      `<td class="${r.insta_margin >= 0 ? 'pos' : 'neg'}">${fmt(r.insta_margin)}</td>`,
      `<td class="${r.insta_roi >= 0 ? 'pos' : 'neg'}">${fmtPct(r.insta_roi)}</td>`,
      `<td>${fmt(r.order_cost)}</td>`,
      `<td>${fmt(r.order_rev)}</td>`,
      `<td class="${r.order_margin >= 0 ? 'pos' : 'neg'}">${fmt(r.order_margin)}</td>`,
      `<td class="${r.order_roi >= 0 ? 'pos' : 'neg'}">${fmtPct(r.order_roi)}</td>`,
      `<td>${fmt(r.week_vol)}</td>`,
      '</tr>'
    );
  }
  tbody.innerHTML = parts.join('');
  rowCount.textContent = total > rows.length
    ? `Showing top ${rows.length} of ${total.toLocaleString()} matching recipes`
    : `Showing ${rows.length} recipes`;
}

document.querySelectorAll('#results th').forEach((th) => {
  const key = th.dataset.key;
  if (!key) return;
  th.style.cursor = 'pointer';
  th.addEventListener('click', () => {
    if (state.sortKey === key) state.sortDir = -state.sortDir;
    else { state.sortKey = key; state.sortDir = -1; }
    document.querySelectorAll('#results th').forEach((x) => {
      x.classList.remove('sorted');
      x.textContent = x.textContent.replace(/ [▼▲]$/, '');
    });
    th.classList.add('sorted');
    th.textContent += state.sortDir === -1 ? ' ▼' : ' ▲';
    calculate();
  });
});

$('refresh').addEventListener('click', async () => {
  try { await fetchBazaar(); calculate(); }
  catch (e) { setStatus('Error: ' + e.message, 'err'); }
});

$('update-recipes').addEventListener('click', async () => {
  try {
    await loadFusionData(FUSION_DATA_REMOTE);
    calculate();
  } catch (e) {
    setStatus('Recipe update failed: ' + e.message, 'err');
  }
});

['tax', 'min-margin', 'min-volume', 'top-n', 'hide-loss', 'best-per-output', 'search']
  .forEach((id) => $(id).addEventListener('input', calculate));
document.querySelectorAll('.rarity').forEach((el) => el.addEventListener('change', calculate));

$('auto-refresh').addEventListener('change', (e) => {
  if (e.target.checked) startAutoRefresh();
  else clearInterval(state.refreshTimer);
});

function startAutoRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(async () => {
    try { await fetchBazaar(); calculate(); } catch {}
  }, REFRESH_MS);
}

(async () => {
  try {
    await loadFusionData(FUSION_DATA_LOCAL);
  } catch (e) {
    setStatus('Local fusion data missing, fetching from SkyShards…');
    try { await loadFusionData(FUSION_DATA_REMOTE); }
    catch (e2) { setStatus('Could not load fusion data: ' + e2.message, 'err'); return; }
  }
  try {
    await fetchBazaar();
    calculate();
    startAutoRefresh();
  } catch (e) {
    setStatus('Bazaar error: ' + e.message, 'err');
  }
})();
