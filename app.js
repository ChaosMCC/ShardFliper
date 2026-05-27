const FUSION_DATA_LOCAL = 'fusion-data.json';
const FUSION_DATA_REMOTE = 'https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/fusion-data.json';
const BAZAAR_URL = 'https://api.hypixel.net/v2/skyblock/bazaar';
const CORS_PROXY = 'https://corsproxy.io/?';
const REFRESH_MS = 60_000;

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

const state = {
  fusionData: null,
  recipeIdx: null,
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
  state.recipeIdx = buildRecipeIndex(data);
  const recipeCount = Object.values(state.recipeIdx).reduce((s, a) => s + a.length, 0);
  setStatus(
    `Loaded ${recipeCount.toLocaleString()} unique recipes across ${Object.keys(data.shards).length} shards`,
    'ok'
  );
}

function buildRecipeIndex(fusionData) {
  const idx = {};
  for (const [outKey, qtyMap] of Object.entries(fusionData.recipes)) {
    const list = idx[outKey] = [];
    const seen = new Set();
    for (const [qStr, pairs] of Object.entries(qtyMap)) {
      const oq = parseInt(qStr, 10);
      for (const [a, b] of pairs) {
        if (!a || !b) continue;
        const k = a < b ? `${a}|${b}|${oq}` : `${b}|${a}|${oq}`;
        if (seen.has(k)) continue;
        seen.add(k);
        list.push({ inputs: [a, b], outputQty: oq });
      }
    }
  }
  return idx;
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

function buyPriceFor(internalId, mode) {
  const p = state.bazaar[internalId]?.quick_status;
  if (!p) return null;
  return mode === 'insta' ? p.buyPrice : p.sellPrice + 0.1;
}

function sellPriceFor(internalId, mode) {
  const p = state.bazaar[internalId]?.quick_status;
  if (!p) return null;
  return mode === 'insta' ? p.sellPrice : p.buyPrice - 0.1;
}

// ---- DP: best chain to make a shard ----

function bestFusion(shardKey, depth, mode, cache) {
  if (depth <= 0) return null;
  const recipes = state.recipeIdx[shardKey];
  if (!recipes || recipes.length === 0) return null;
  const shards = state.fusionData.shards;
  let best = null;
  for (const r of recipes) {
    const a = shards[r.inputs[0]];
    const b = shards[r.inputs[1]];
    if (!a || !b) continue;
    const cA = minCost(r.inputs[0], depth - 1, mode, cache);
    const cB = minCost(r.inputs[1], depth - 1, mode, cache);
    if (!cA || !cB) continue;
    const cost = (a.fuse_amount * cA.costPerUnit + b.fuse_amount * cB.costPerUnit) / r.outputQty;
    if (best === null || cost < best.costPerUnit) {
      best = { shardKey, costPerUnit: cost, source: 'fusion', recipe: r, children: [cA, cB] };
    }
  }
  return best;
}

function minCost(shardKey, depth, mode, cache) {
  const memoKey = `${shardKey}|${depth}|${mode}`;
  if (cache.has(memoKey)) return cache.get(memoKey);
  const shard = state.fusionData.shards[shardKey];
  if (!shard) { cache.set(memoKey, null); return null; }

  let best = null;
  const bp = buyPriceFor(shard.internal_id, mode);
  if (bp != null && bp > 0) best = { shardKey, costPerUnit: bp, source: 'bazaar' };

  if (depth > 0) {
    const fusion = bestFusion(shardKey, depth, mode, cache);
    if (fusion && (!best || fusion.costPerUnit < best.costPerUnit)) best = fusion;
  }

  cache.set(memoKey, best);
  return best;
}

function chainDepth(node) {
  if (!node || node.source !== 'fusion') return 0;
  return 1 + Math.max(chainDepth(node.children[0]), chainDepth(node.children[1]));
}

function chainSteps(node, shards) {
  // Returns steps in leaves-first order: every intermediate fusion, then the root.
  const steps = [];
  function walk(n) {
    if (!n || n.source !== 'fusion') return;
    walk(n.children[0]);
    walk(n.children[1]);
    const a = shards[n.recipe.inputs[0]];
    const b = shards[n.recipe.inputs[1]];
    steps.push({
      aName: a.name, aQty: a.fuse_amount,
      bName: b.name, bQty: b.fuse_amount,
      outName: shards[n.shardKey].name, outQty: n.recipe.outputQty,
    });
  }
  walk(node);
  return steps;
}

function collectLeaves(node, shards) {
  // Aggregated bazaar-bought shards needed for 1 execution of the final fusion.
  const leaves = new Map();
  function walk(n, units) {
    if (n.source !== 'fusion') {
      const name = shards[n.shardKey].name;
      leaves.set(name, (leaves.get(name) || 0) + units);
      return;
    }
    const fusions = units / n.recipe.outputQty;
    const a = shards[n.recipe.inputs[0]];
    const b = shards[n.recipe.inputs[1]];
    walk(n.children[0], fusions * a.fuse_amount);
    walk(n.children[1], fusions * b.fuse_amount);
  }
  walk(node, node.recipe.outputQty);
  return leaves;
}

function recostChain(node, mode, shards) {
  // Re-evaluate the same chain structure under a different price mode.
  if (node.source !== 'fusion') {
    return buyPriceFor(shards[node.shardKey].internal_id, mode);
  }
  const a = shards[node.recipe.inputs[0]];
  const b = shards[node.recipe.inputs[1]];
  const cA = recostChain(node.children[0], mode, shards);
  const cB = recostChain(node.children[1], mode, shards);
  if (cA == null || cB == null) return null;
  return (a.fuse_amount * cA + b.fuse_amount * cB) / node.recipe.outputQty;
}

// ---- formatting ----

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

function fmtQty(n) {
  if (Math.abs(n - Math.round(n)) < 1e-6) return Math.round(n).toString();
  return n.toFixed(1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- main calculation + render ----

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
  const maxDepth = parseInt($('max-depth').value, 10) || 1;
  const optMode = $('opt-mode').value;
  const allowedRarities = new Set(
    Array.from(document.querySelectorAll('.rarity:checked')).map((el) => el.value)
  );
  const search = ($('search').value || '').trim().toLowerCase();

  const shards = state.fusionData.shards;
  const cache = new Map();
  const rows = [];

  for (const [shardKey, shard] of Object.entries(shards)) {
    if (!allowedRarities.has(shard.rarity)) continue;
    if (search && !shard.name.toLowerCase().includes(search)) continue;

    const outPx = state.bazaar[shard.internal_id]?.quick_status;
    if (!outPx) continue;
    if (outPx.sellMovingWeek < minVol) continue;

    const chain = bestFusion(shardKey, maxDepth, optMode, cache);
    if (!chain) continue;

    const outQty = chain.recipe.outputQty;
    const instaCostPerUnit = recostChain(chain, 'insta', shards);
    const orderCostPerUnit = recostChain(chain, 'order', shards);
    if (instaCostPerUnit == null || orderCostPerUnit == null) continue;

    const instaCost = instaCostPerUnit * outQty;
    const orderCost = orderCostPerUnit * outQty;
    const instaRev = outPx.sellPrice * outQty * (1 - tax);
    const orderRev = (outPx.buyPrice - 0.1) * outQty * (1 - tax);
    const instaMargin = instaRev - instaCost;
    const orderMargin = orderRev - orderCost;
    const instaRoi = instaCost > 0 ? instaMargin / instaCost : 0;
    const orderRoi = orderCost > 0 ? orderMargin / orderCost : 0;

    if (hideLoss && instaMargin < 0 && orderMargin < 0) continue;
    if (Math.max(instaMargin, orderMargin) < minMargin) continue;

    rows.push({
      outputKey: shardKey,
      output_name: shard.name,
      output_qty: outQty,
      rarity: shard.rarity,
      steps: chainDepth(chain),
      step_list: chainSteps(chain, shards),
      leaves: collectLeaves(chain, shards),
      insta_cost: instaCost,
      insta_rev: instaRev,
      insta_margin: instaMargin,
      insta_roi: instaRoi,
      order_cost: orderCost,
      order_rev: orderRev,
      order_margin: orderMargin,
      order_roi: orderRoi,
      week_vol: outPx.sellMovingWeek,
    });
  }

  const k = state.sortKey;
  rows.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === 'rarity') { av = RARITY_ORDER[av]; bv = RARITY_ORDER[bv]; }
    if (typeof av === 'string') return av.localeCompare(bv) * state.sortDir;
    return (av - bv) * state.sortDir;
  });

  const total = rows.length;
  render(rows.slice(0, topN), total);
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
    // Steps from leaves-first to root; render root first (most important), then sub-steps.
    const stepsHtml = r.step_list
      .map((s, i) => {
        const cls = i === r.step_list.length - 1 ? 'step-final' : 'step-sub';
        return `<div class="${cls}">${s.aQty}× ${escapeHtml(s.aName)} + ${s.bQty}× ${escapeHtml(s.bName)} → ${s.outQty}× ${escapeHtml(s.outName)}</div>`;
      })
      .reverse()
      .join('');
    let leavesHtml = '';
    if (r.steps > 1) {
      const leavesText = Array.from(r.leaves.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, qty]) => `${fmtQty(qty)}× ${escapeHtml(name)}`)
        .join(' + ');
      leavesHtml = `<div class="leaves">Buy: ${leavesText}</div>`;
    }
    parts.push(
      '<tr>',
      `<td>${r.output_qty}× ${escapeHtml(r.output_name)}</td>`,
      `<td class="rarity-${r.rarity}">${r.rarity}</td>`,
      `<td class="steps">${r.steps}</td>`,
      `<td class="recipe-cell">${stepsHtml}${leavesHtml}</td>`,
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
    ? `Showing top ${rows.length} of ${total.toLocaleString()} matching outputs`
    : `Showing ${rows.length} outputs`;
}

// ---- event handlers ----

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

['tax', 'min-margin', 'min-volume', 'top-n', 'search']
  .forEach((id) => $(id).addEventListener('input', calculate));
['hide-loss', 'max-depth', 'opt-mode']
  .forEach((id) => $(id).addEventListener('change', calculate));
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
