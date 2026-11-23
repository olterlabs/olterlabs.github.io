/* KajaKeret – költségkeret-alapú heti menütervező (2 fő, 5 nap) */
(function () {
  'use strict';
  const D = window.KK_DATA;
  const DAYS = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];
  const PORTIONS = 10; // 2 fő × 5 nap
  const RCATS = { fozelek: 'Főzelék', teszta: 'Tészta', hus: 'Húsos', egytal: 'Egytálétel', rakott: 'Rakott' };
  const PRESETS = [['Spórolós', 7000], ['Takarékos', 9000], ['Átlagos', 12000], ['Bőséges', 16000], ['Prémium', 21000]];
  const MIN = 4000, MAX = 25000;

  /* ---------- tárolás ---------- */
  const store = {
    get(k, def) { try { const v = localStorage.getItem('kk.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('kk.' + k, JSON.stringify(v)); } catch (e) { /* privát mód */ } }
  };

  /* ---------- állapot ---------- */
  const products = D.products.map(([id, name, size, unit, price, cat, aliases, pc]) => ({ id, name, size, unit, base: price, cat, aliases, pc }));
  const P = Object.fromEntries(products.map(p => [p.id, p]));
  const PIDX = Object.fromEntries(products.map((p, i) => [p.id, i]));

  const S = {
    budget: clamp(store.get('budget', 10000)),
    mode: store.get('mode', 'basket'),
    pantry: new Set(store.get('pantry', D.defaultPantry)),
    prices: store.get('prices', {}),
    own: store.get('own', []),
    menu: store.get('menu', []),
    tab: store.get('tab', 'menu')
  };
  const price = id => (S.prices[id] != null ? S.prices[id] : P[id].base);
  const save = () => { store.set('budget', S.budget); store.set('mode', S.mode); store.set('pantry', [...S.pantry]); store.set('prices', S.prices); store.set('own', S.own); store.set('menu', S.menu); store.set('tab', S.tab); };

  function allRecipes() { return D.recipes.map(r => Object.assign({ src: 'builtin' }, r)).concat(S.own); }
  function recipeById(id) { return allRecipes().find(r => r.id === id); }

  /* ---------- segédek ---------- */
  function clamp(v) { v = Math.round(Number(v) || 0); return Math.min(MAX, Math.max(MIN, v)); }
  const ft = n => Math.round(n).toLocaleString('hu-HU') + ' Ft';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = s => document.querySelector(s);
  function fmtQty(q, unit) {
    const nf = (x, d) => x.toLocaleString('hu-HU', { maximumFractionDigits: d });
    if (unit === 'db') return nf(q, 1) + ' db';
    if (unit === 'g') return q >= 1000 ? nf(q / 1000, 2) + ' kg' : nf(q, q < 10 ? 1 : 0) + ' g';
    if (unit === 'ml') return q >= 1000 ? nf(q / 1000, 2) + ' l' : (q >= 100 && q % 100 === 0 ? nf(q / 100, 1) + ' dl' : nf(q, 0) + ' ml');
    return q + ' ' + unit;
  }
  const packLabel = p => fmtQty(p.size, p.unit);
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }

  /* ---------- költségszámítás ---------- */
  function needsOf(ids) {
    const needs = {};
    ids.forEach(id => { const r = recipeById(id); if (r) r.ing.forEach(([pid, q]) => { if (P[pid]) needs[pid] = (needs[pid] || 0) + q; }); });
    return needs;
  }
  function costOf(ids) {
    const needs = needsOf(ids);
    let basket = 0, portion = 0;
    for (const pid in needs) {
      if (S.pantry.has(pid)) continue;
      const p = P[pid], pr = price(pid);
      basket += Math.ceil(needs[pid] / p.size - 1e-9) * pr;
      portion += needs[pid] / p.size * pr;
    }
    return { basket, portion, needs, value: S.mode === 'basket' ? basket : portion };
  }
  function recipePortionCost(r, ignorePantry) {
    return r.ing.reduce((s, [pid, q]) => s + (P[pid] && (ignorePantry || !S.pantry.has(pid)) ? q / P[pid].size * price(pid) : 0), 0);
  }

  /* gyors, tömbös költségszámítás az optimalizáláshoz */
  function makeEvaluator(pool) {
    const n = products.length;
    const unitPrice = products.map(p => (S.pantry.has(p.id) ? 0 : price(p.id)));
    const sizes = products.map(p => p.size);
    const vecs = pool.map(r => r.ing.filter(([pid]) => PIDX[pid] != null).map(([pid, q]) => [PIDX[pid], q]));
    const acc = new Float64Array(n);
    return function (idx) {
      const touched = [];
      for (const i of idx) for (const [k, q] of vecs[i]) { if (acc[k] === 0) touched.push(k); acc[k] += q; }
      let basket = 0, portion = 0;
      for (const k of touched) { const r = acc[k] / sizes[k]; basket += Math.ceil(r - 1e-9) * unitPrice[k]; portion += r * unitPrice[k]; acc[k] = 0; }
      return { basket, portion, value: S.mode === 'basket' ? basket : portion };
    };
  }
  function scoreOf(c, idx, pool, prev) {
    const eff = c.basket > 0 ? c.portion / c.basket : 1;          // maradékhasznosítás
    const use = Math.min(1, c.value / S.budget);                  // a keret kihasználása
    const repeat = idx.filter(i => prev.has(pool[i].id)).length;  // ismétlés az előző menüből
    return 0.5 * eff + 0.45 * use - 0.12 * repeat + 0.28 * Math.random();
  }
  function catOk(idx, pool) {
    const c = {};
    for (const i of idx) { const k = pool[i].cat || 'egyeb'; c[k] = (c[k] || 0) + 1; if (c[k] > 2) return false; }
    return true;
  }

  function generate() {
    const pool = allRecipes();
    const ev = makeEvaluator(pool);
    const prev = new Set(S.menu);
    let best = null, bestScore = -Infinity, cheapest = null;
    const pick = new Array(pool.length).fill(0).map((_, i) => i);
    for (let t = 0; t < 8000; t++) {
      for (let j = 0; j < 5; j++) { const r = j + Math.floor(Math.random() * (pick.length - j)); [pick[j], pick[r]] = [pick[r], pick[j]]; }
      const idx = pick.slice(0, 5);
      if (!catOk(idx, pool)) continue;
      const c = ev(idx);
      if (!cheapest || c.value < cheapest.c.value) cheapest = { idx, c };
      if (c.value > S.budget) continue;
      const sc = scoreOf(c, idx, pool, prev);
      if (sc > bestScore) { bestScore = sc; best = { idx, c }; }
    }
    if (!best && cheapest) {
      // több véletlen kiindulópontból keressük a legolcsóbb összeállítást
      for (let k = 0; k < 40; k++) {
        const order = pool.map((_, i) => i).sort(() => Math.random() - 0.5);
        const idx = [];
        for (const i of order) { if (idx.length < 5 && catOk(idx.concat(i), pool)) idx.push(i); }
        const loc = cheapestLocal({ idx, c: ev(idx) }, pool, ev);
        if (loc.c.value < cheapest.c.value) cheapest = loc;
      }
    }
    if (!best && cheapest.c.value <= S.budget) best = cheapest;
    const chosen = best || cheapest;
    S.menu = chosen.idx.map(i => pool[i].id);
    if (!best) toast('A keret túl szűk: a legolcsóbb lehetséges heti menü ' + ft(chosen.c.value) + '.');
    save();
    renderAll();
  }

  /* lokális keresés: napokat cserélget, amíg csökken a költség */
  function cheapestLocal(start, pool, ev) {
    let cur = start;
    for (let improved = true, pass = 0; improved && pass < 30; pass++) {
      improved = false;
      for (let d = 0; d < 5; d++) for (let i = 0; i < pool.length; i++) {
        if (cur.idx.includes(i)) continue;
        const idx = cur.idx.slice(); idx[d] = i;
        if (!catOk(idx, pool)) continue;
        const c = ev(idx);
        if (c.value < cur.c.value - 0.01) { cur = { idx, c }; improved = true; }
      }
    }
    return cur;
  }

  function swapDay(d) {
    const pool = allRecipes();
    const ev = makeEvaluator(pool);
    const pos = Object.fromEntries(pool.map((r, i) => [r.id, i]));
    const cur = S.menu.map(id => pos[id]);
    const cands = [];
    pool.forEach((r, i) => {
      if (cur.includes(i)) return;
      const idx = cur.slice(); idx[d] = i;
      if (!catOk(idx, pool)) return;
      const c = ev(idx);
      if (c.value <= S.budget) cands.push({ i, s: scoreOf(c, idx, pool, new Set()) });
    });
    if (!cands.length) { toast('Nincs olyan csere, amivel a kereten belül maradnál.'); return; }
    cands.sort((a, b) => b.s - a.s);
    const pickC = cands[Math.floor(Math.random() * Math.min(4, cands.length))];
    S.menu[d] = pool[pickC.i].id;
    save();
    renderAll();
    toast(DAYS[d] + ': ' + pool[pickC.i].name);
  }

  /* ---------- megjelenítés ---------- */
  function renderBudget() {
    $('#budgetInput').value = S.budget;
    $('#budgetRange').value = S.budget;
    document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.budget));
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === S.mode));
    $('#modeHint').textContent = S.mode === 'basket'
      ? 'A pénztárnál ténylegesen fizetendő összeg egész kiszerelésekkel (pl. 330 g tejföl, 10 db tojás). A tervező olyan ételeket párosít, amelyek felhasználják egymás maradékait.'
      : 'Csak a 10 adaghoz ténylegesen felhasznált grammok/ml-ek arányos ára – a maradék alapanyag nem számít bele.';
  }

  function renderSummary() {
    const c = costOf(S.menu);
    const over = c.value > S.budget + 0.5;
    const el = $('#summary');
    el.classList.toggle('over', over);
    const waste = c.basket - c.portion;
    el.innerHTML =
      `<div class="stat total"><b>${ft(c.value)}</b><span>${S.mode === 'basket' ? 'fizetendő a boltban' : 'felhasznált alapanyag'} · keret: ${ft(S.budget)}</span></div>` +
      `<div class="stat"><b>${ft(c.value / PORTIONS)}</b><span>adagonként</span></div>` +
      `<div class="stat"><b>${ft(Math.abs(S.budget - c.value))}</b><span>${over ? 'kereten felül' : 'marad a keretből'}</span></div>` +
      `<div class="bar"><i style="width:${Math.min(100, c.value / S.budget * 100).toFixed(1)}%"></i></div>` +
      `<p class="note">${over ? 'Túllépted a keretet – kérj új menüt, vagy pipáld ki, ami otthon van.' :
        S.mode === 'basket' ? `Ebből kb. ${ft(waste)} értékű alapanyag marad meg a jövő hétre (felhasznált: ${ft(c.portion)}).`
          : `A boltban egész kiszerelésekkel ${ft(c.basket)} lenne a kosár.`}</p>`;
  }

  function renderDays() {
    $('#days').innerHTML = S.menu.map((id, d) => {
      const r = recipeById(id);
      if (!r) return '';
      return `<li class="day"><span class="dname">${DAYS[d]}</span>
        <div><button class="dish" data-open="${esc(r.id)}">${esc(r.name)}</button>${r.src !== 'builtin' ? '<span class="tag own">saját</span>' : ''}
        <div class="meta">${RCATS[r.cat] || 'Főétel'} · ${r.time} perc · 2 adag ≈ ${ft(recipePortionCost(r))}</div></div>
        <div class="acts"><button class="btn small" data-swap="${d}" title="Csere a kereten belül">🔄 Csere</button></div></li>`;
    }).join('');
  }

  function renderShop() {
    const c = costOf(S.menu);
    const usedBy = {};
    S.menu.forEach((id, d) => { const r = recipeById(id); if (r) r.ing.forEach(([pid]) => { (usedBy[pid] = usedBy[pid] || new Set()).add(DAYS[d].slice(0, 3)); }); });
    const groups = {};
    Object.keys(c.needs).forEach(pid => { (groups[P[pid].cat] = groups[P[pid].cat] || []).push(pid); });
    let html = '';
    Object.keys(D.categories).forEach(cat => {
      if (!groups[cat]) return;
      html += `<div class="shop-group"><h3>${D.categories[cat]}</h3>`;
      groups[cat].sort((a, b) => P[a].name.localeCompare(P[b].name, 'hu')).forEach(pid => {
        const p = P[pid], need = c.needs[pid], packs = Math.ceil(need / p.size - 1e-9), have = S.pantry.has(pid);
        const val = S.mode === 'basket' ? packs * price(pid) : need / p.size * price(pid);
        const left = packs * p.size - need;
        html += `<label class="shop-item${have ? ' have' : ''}">
          <input type="checkbox" data-pantry="${pid}" ${have ? 'checked' : ''} aria-label="Van otthon: ${esc(p.name)}">
          <div><div class="nm">${esc(p.name)}</div>
          <div class="sub">kell ${fmtQty(need, p.unit)} → ${packs} × ${packLabel(p)}${left > 0.01 ? ` · marad ${fmtQty(left, p.unit)}` : ''} · ${[...usedBy[pid]].join(', ')}${have ? ' · <b>van otthon</b>' : ''}</div></div>
          <div class="pr">${ft(val)}</div></label>`;
      });
      html += '</div>';
    });
    html += `<div class="shop-total"><span>Fizetendő (${S.mode === 'basket' ? 'egész kiszerelések' : 'felhasznált mennyiség'})</span><span>${ft(c.value)}</span></div>`;
    $('#shopList').innerHTML = html;
  }

  function renderRecipes() {
    const q = $('#recipeSearch').value.trim().toLowerCase();
    const list = allRecipes().filter(r => !q || r.name.toLowerCase().includes(q) || r.ing.some(([pid]) => P[pid] && P[pid].name.toLowerCase().includes(q)));
    $('#recipeGrid').innerHTML = list.map(r =>
      `<button class="rcard" data-open="${esc(r.id)}"><b>${esc(r.name)}${r.src !== 'builtin' ? '<span class="tag own">' + (r.src === 'wikibooks' ? 'Wikikönyvek' : 'saját') + '</span>' : ''}</b>
       <span>${RCATS[r.cat] || 'Főétel'} · ${r.time} perc · 2 adag ≈ ${ft(recipePortionCost(r))}${S.menu.includes(r.id) ? ' · <b>a heti menüben</b>' : ''}</span></button>`).join('')
      || '<p class="hint">Nincs találat.</p>';
  }

  function renderPrices() {
    $('#priceDate').textContent = D.priceDate.replace('-', '. ') + '.';
    let html = '';
    Object.keys(D.categories).forEach(cat => {
      html += `<h3>${D.categories[cat]}</h3>`;
      products.filter(p => p.cat === cat).forEach(p => {
        html += `<div class="price-row${S.prices[p.id] != null ? ' changed' : ''}"><div><div class="nm">${esc(p.name)}</div><div class="pk">${packLabel(p)} · alapár ${ft(p.base)}</div></div>
          <input type="number" min="0" step="10" inputmode="numeric" value="${price(p.id)}" data-price="${p.id}" aria-label="${esc(p.name)} ára"><span>Ft</span></div>`;
      });
    });
    $('#priceTable').innerHTML = html;
  }

  function renderTabs() {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === S.tab));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + S.tab));
  }

  function renderAll() { renderBudget(); renderSummary(); renderDays(); renderShop(); renderRecipes(); renderTabs(); }

  /* ---------- recept részletek ---------- */
  function sourceHtml(r) {
    if (r.src === 'wikibooks' && r.wb) {
      const t = r.wb.title;
      const url = 'https://hu.wikibooks.org/wiki/' + encodeURI(t.replace(/ /g, '_'));
      const hist = 'https://hu.wikibooks.org/w/index.php?title=' + encodeURIComponent(t.replace(/ /g, '_')) + '&action=history';
      return `Forrás: <a href="${esc(url)}" target="_blank" rel="noopener">„${esc(t)}” – Wikikönyvek</a>. Szerzők: a Wikikönyvek közreműködői (<a href="${esc(hist)}" target="_blank" rel="noopener">laptörténet</a>). ` +
        `Licenc: <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.hu" target="_blank" rel="noopener">CC BY-SA 4.0</a>. ` +
        `Módosítások: 2 főre átszámolva${r.wb.servings ? ` (eredetileg ${r.wb.servings} főre${r.wb.guessed ? ', becsült' : ''})` : ''}, mértékegységek grammra/ml-re váltva, alapanyagok bolti termékekhez rendelve. ` +
        `Ez a módosított recept ugyanezen licenc alatt szabadon másolható és továbbadható.`;
    }
    if (r.src === 'own') return 'Saját recept – a te böngésződben tárolva.';
    return 'Saját, minimalista megfogalmazás – KajaKeret (mennyiségek, idők, hőfokok tényadatai alapján).';
  }

  function openRecipe(id) {
    const r = recipeById(id);
    if (!r) return;
    $('#rdTitle').textContent = r.name;
    const rows = r.ing.filter(([pid]) => P[pid]).map(([pid, q]) => {
      const have = S.pantry.has(pid);
      return `<tr class="${have ? 'pantry' : ''}"><td class="q">${fmtQty(q, P[pid].unit)}</td><td>${esc(P[pid].name)}${have ? ' <span class="tag">van otthon</span>' : ''}</td><td class="c">${ft(q / P[pid].size * price(pid))}</td></tr>`;
    }).join('');
    $('#rdBody').innerHTML =
      `<p class="hint">${RCATS[r.cat] || 'Főétel'} · ${r.time} perc · 2 adag · felhasznált alapanyag ≈ <b>${ft(recipePortionCost(r))}</b> (kamrával együtt ${ft(recipePortionCost(r, true))})</p>
       <h3>Hozzávalók (2 főre)</h3><table class="ing-table">${rows}</table>
       <h3>Elkészítés</h3><ol class="steps">${r.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
       <div class="source">${sourceHtml(r)}</div>
       ${r.src !== 'builtin' ? `<div class="row end"><button class="btn" data-edit="${esc(r.id)}">Szerkesztés</button></div>` : ''}`;
    $('#recipeDlg').showModal();
  }

  /* ---------- szerkesztő ---------- */
  let editing = null, wbMeta = null;
  function productOptions(sel, unknownLabel) {
    let h = `<option value="">${unknownLabel ? '❓ ' + esc(unknownLabel) + ' – válassz' : '— válassz alapanyagot —'}</option>`;
    Object.keys(D.categories).forEach(cat => {
      h += `<optgroup label="${D.categories[cat]}">` + products.filter(p => p.cat === cat).map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('') + '</optgroup>';
    });
    return h;
  }
  function addIngRow(pid, q, unknownLabel) {
    const row = document.createElement('div');
    row.className = 'ed-ing';
    row.innerHTML = `<select>${productOptions(pid, unknownLabel)}</select><input type="number" min="0" step="any" value="${q == null ? '' : q}" placeholder="menny."><span class="u">${pid ? P[pid].unit : ''}</span><button type="button" aria-label="Sor törlése">✕</button>`;
    $('#edIngs').appendChild(row);
  }
  function readIngs() {
    const out = {};
    document.querySelectorAll('#edIngs .ed-ing').forEach(row => {
      const pid = row.querySelector('select').value, q = parseFloat(row.querySelector('input').value);
      if (pid && q > 0) out[pid] = (out[pid] || 0) + q;
    });
    return Object.entries(out);
  }
  function updateEdCost() {
    const ing = readIngs();
    $('#edCost').textContent = ing.length ? `2 adag felhasznált alapanyagköltsége ≈ ${ft(recipePortionCost({ ing }, true))}` : '';
  }
  function openEditor(r) {
    editing = r || null;
    wbMeta = r && r.wb ? r.wb : null;
    $('#edName').value = r ? r.name : '';
    $('#edCat').innerHTML = Object.entries(RCATS).map(([k, v]) => `<option value="${k}"${(r ? r.cat : 'egytal') === k ? ' selected' : ''}>${v}</option>`).join('');
    $('#edTime').value = r ? r.time : 40;
    $('#edIngs').innerHTML = '';
    $('#edUnmatched').innerHTML = '';
    (r ? r.ing : [[null, null], [null, null], [null, null]]).forEach(([pid, q]) => addIngRow(pid, q));
    $('#edSteps').value = r ? r.steps.join('\n') : '';
    $('#edShare').checked = !!(r && r.share);
    $('#edDelete').hidden = !r;
    $('#wbRaw').value = ''; $('#wbMsg').textContent = '';
    $('#importBox').open = !r;
    $('#edSource').innerHTML = r ? sourceHtml(r) : '';
    updateEdCost();
    $('#editDlg').showModal();
  }
  function saveEditor() {
    const name = $('#edName').value.trim();
    const ing = readIngs();
    const steps = $('#edSteps').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!name) { toast('Adj nevet a receptnek.'); return; }
    if (!ing.length) { toast('Legalább egy hozzávaló kell (alapanyag + mennyiség).'); return; }
    const r = {
      id: editing ? editing.id : 'own-' + Date.now().toString(36),
      name, cat: $('#edCat').value, time: Math.max(5, parseInt($('#edTime').value, 10) || 30),
      ing, steps: steps.length ? steps : ['(Nincs megadva elkészítési leírás.)'],
      src: wbMeta ? 'wikibooks' : 'own', share: $('#edShare').checked
    };
    if (wbMeta) r.wb = wbMeta;
    const i = S.own.findIndex(x => x.id === r.id);
    if (i >= 0) S.own[i] = r; else S.own.push(r);
    save();
    $('#editDlg').close();
    renderAll();
    toast('Mentve: ' + r.name + ' – bekerült a menütervezőbe.');
  }
  function deleteEditor() {
    if (!editing || !confirm('Biztosan törlöd: ' + editing.name + '?')) return;
    S.own = S.own.filter(x => x.id !== editing.id);
    const gone = S.menu.includes(editing.id);
    save();
    $('#editDlg').close();
    if (gone) generate(); else renderAll();
    toast('Recept törölve.');
  }

  /* ---------- Wikikönyvek wikitext importáló ---------- */
  const UNITS = [ // [minták, szorzó g/ml-re, típus]
    [['dkg', 'deka', 'dekagramm'], 10], [['kg', 'kiló', 'kilogramm'], 1000], [['g', 'gr', 'gramm'], 1],
    [['dl', 'deciliter'], 100], [['cl'], 10], [['ml', 'milliliter'], 1], [['l', 'liter'], 1000],
    [['ek', 'evőkanál', 'evőkanálnyi', 'evőkanalnyi'], 15], [['tk', 'teáskanál', 'teáskanálnyi', 'kk', 'kávéskanál', 'kávéskanálnyi'], 5],
    [['mk', 'mokkáskanál', 'mokkáskanálnyi'], 2], [['csipet', 'csipetnyi', 'csipetnyit'], 0.5],
    [['bögre', 'bögrényi'], 250], [['pohár', 'pohárnyi'], 200], [['marék', 'maréknyi'], 30],
    [['gerezd'], 'gerezd'], [['fej'], 'fej'], [['csomag', 'csomagnyi', 'cs', 'doboz', 'konzerv', 'üveg'], 'pack'],
    [['db', 'darab', 'szem', 'szál', 'szelet', 'közepes', 'nagy', 'kis', 'kisebb', 'nagyobb'], 'piece']
  ];
  const UNIT_MAP = {}; UNITS.forEach(([names, f]) => names.forEach(n => { UNIT_MAP[n] = f; }));
  const UNIT_RE = new RegExp('^(' + Object.keys(UNIT_MAP).sort((a, b) => b.length - a.length).map(u => u.replace('.', '\\.')).join('|') + ')\\.?(?=[\\s,]|$)\\s*', 'i');
  const WORDNUM = { 'fél': 0.5, 'egy': 1, 'másfél': 1.5, 'két': 2, 'kettő': 2, 'három': 3, 'négy': 4, 'öt': 5, 'hat': 6, 'pár': 2 };
  const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

  function cleanWiki(s) {
    return s.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[\s\S]*?<\/ref>/gi, '')
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/\[\[(?:Fájl|File|Kép|Image|Kategória|Category):[^\]]*\]\]/gi, '')
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, '$1')
      .replace(/'''?/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function matchProduct(name) {
    const n = name.toLowerCase();
    let best = null, len = 0;
    products.forEach(p => p.aliases.forEach(a => { if (a.length > len && n.includes(a)) { best = p; len = a.length; } }));
    return best;
  }
  function parseQty(text) {
    let t = text.replace(/^(?:kb\.?|kb|cca\.?|kevés|kis|egy kevés)\s+/i, '');
    let m = t.match(/^(\d+)\s*\/\s*(\d+)\s*/);
    if (m) return [m[1] / m[2], t.slice(m[0].length)];
    m = t.match(/^(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*([½¼¾])?\s*/);
    if (m) {
      const a = parseFloat(m[1].replace(',', '.')), b = m[2] ? parseFloat(m[2].replace(',', '.')) : a;
      return [(a + b) / 2 + (m[3] ? FRAC[m[3]] : 0), t.slice(m[0].length)];
    }
    m = t.match(/^([½¼¾⅓⅔])\s*/);
    if (m) return [FRAC[m[1]], t.slice(m[0].length)];
    m = t.toLowerCase().match(/^(fél|egy|másfél|két|kettő|három|négy|öt|hat|pár)\s+/);
    if (m) return [WORDNUM[m[1]], t.slice(m[0].length)];
    return [null, t];
  }
  function toProductUnit(qty, unit, p) {
    if (unit == null) unit = 'piece';
    if (typeof unit === 'number') { const g = qty * unit; return p.unit === 'db' ? g / (p.pc || 60) : g; }
    if (unit === 'pack') return qty * p.size;
    if (p.unit === 'db') return qty;
    if (unit === 'gerezd') return qty * 5;
    if (unit === 'fej') return qty * (p.id === 'fokhagyma' ? 50 : (p.pc || 100));
    return qty * (p.pc || 100); // darab
  }
  function roundQty(q, p) {
    if (p.unit === 'db') return Math.max(1, Math.round(q));
    if (q >= 50) return Math.round(q / 5) * 5;
    if (q >= 5) return Math.round(q);
    return Math.round(q * 10) / 10;
  }
  function parseWikitext(raw) {
    let servings = null, guessed = false;
    const sm = raw.match(/(?:adag|személy|fő|létszám)\s*=\s*(\d+)/i) || raw.match(/(\d+)\s*(?:fő|személy|adag)/i);
    if (sm) servings = parseInt(sm[1], 10);
    if (!servings || servings > 20) { servings = 4; guessed = true; }
    const factor = 2 / servings;
    let section = '', ingsRaw = [], steps = [], paras = [];
    raw.split(/\r?\n/).forEach(line => {
      const h = line.match(/^\s*=+\s*(.*?)\s*=+\s*$/);
      if (h) { const t = h[1].toLowerCase(); section = /hozzáv/.test(t) ? 'ing' : /elkész|készít|módja|recept/.test(t) ? 'steps' : 'other'; return; }
      const l = line.trim();
      if (!l) return;
      if (/^[*]/.test(l) && section !== 'steps' && section !== 'other') ingsRaw.push(cleanWiki(l.replace(/^[*#:;]+/, '')));
      else if (/^#/.test(l) && section !== 'ing') steps.push(cleanWiki(l.replace(/^[#*:]+/, '')));
      else if (section === 'steps' && !/^[{|}!]/.test(l)) {
        const c = cleanWiki(l.replace(/^[*:]+/, ''));
        if (c) paras.push(c);
      }
    });
    if (!steps.length) steps = paras;
    const agg = {}, unmatched = [];
    ingsRaw.filter(Boolean).forEach(text => {
      let [qty, rest] = parseQty(text);
      let unit = null;
      const um = rest.match(UNIT_RE);
      if (um) { unit = UNIT_MAP[um[1].toLowerCase()]; rest = rest.slice(um[0].length); }
      if (qty == null) {
        // pl. „só, bors ízlés szerint” – több fűszer egy sorban
        const parts = rest.split(/,|\s+és\s+/).map(s => s.trim()).filter(Boolean);
        let any = false;
        parts.forEach(pt => { const p = matchProduct(pt); if (p && p.cat === 'fuszer') { agg[p.id] = (agg[p.id] || 0) + (p.id === 'so' ? 5 : p.id === 'olaj' ? 20 : 1) / factor; any = true; } });
        if (any) return;
      }
      const p = matchProduct(rest);
      if (!p) { unmatched.push({ text, q: null }); return; }
      if (qty == null) { unmatched.push({ text, q: null, pid: p.id }); return; }
      agg[p.id] = (agg[p.id] || 0) + toProductUnit(qty, unit, p);
    });
    const ing = Object.entries(agg).map(([pid, q]) => [pid, roundQty(q * factor, P[pid])]);
    return { ing, unmatched, steps, servings, guessed };
  }

  async function fetchWikibooks() {
    const title = $('#wbTitle').value.trim();
    if (!title) { $('#wbMsg').textContent = 'Add meg az oldal címét.'; return; }
    $('#wbMsg').textContent = 'Betöltés…';
    try {
      const url = 'https://hu.wikibooks.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&origin=*&page=' + encodeURIComponent(title);
      const res = await fetch(url);
      const j = await res.json();
      if (j.error) throw new Error(j.error.info || 'Nincs ilyen oldal');
      $('#wbRaw').value = j.parse.wikitext;
      $('#wbTitle').value = j.parse.title;
      $('#wbMsg').textContent = 'Betöltve – kattints a Feldolgozásra.';
    } catch (e) {
      $('#wbMsg').textContent = 'Nem sikerült betölteni (' + e.message + '). Másold be kézzel a nyers szöveget.';
    }
  }

  function runImport() {
    const raw = $('#wbRaw').value;
    const title = $('#wbTitle').value.trim();
    if (!raw.trim()) { $('#wbMsg').textContent = 'Nincs feldolgozható szöveg.'; return; }
    const res = parseWikitext(raw);
    if (!res.ing.length && !res.unmatched.length) { $('#wbMsg').textContent = 'Nem találtam hozzávaló-listát (* kezdetű sorok a „Hozzávalók” szakaszban).'; return; }
    const shortName = title ? title.split('/').pop().replace(/_/g, ' ') : '';
    if (shortName) $('#edName').value = shortName;
    $('#edIngs').innerHTML = '';
    res.ing.forEach(([pid, q]) => addIngRow(pid, q));
    res.unmatched.forEach(u => addIngRow(u.pid || null, null, u.text));
    if (res.steps.length) $('#edSteps').value = res.steps.join('\n');
    $('#edUnmatched').innerHTML = res.unmatched.length
      ? `<div class="unmatched">${res.unmatched.length} hozzávalónál nem tudtam biztosan mennyiséget vagy bolti terméket rendelni (❓-lel jelölve). Pótold kézzel, vagy töröld a sort.</div>` : '';
    wbMeta = title ? { title, servings: res.servings, guessed: res.guessed } : null;
    $('#edSource').innerHTML = wbMeta ? sourceHtml({ src: 'wikibooks', wb: wbMeta }) : '<span>Cím nélkül nem tudok forrásmegjelölést generálni – Wikikönyvek-recepthez add meg az oldal címét.</span>';
    $('#wbMsg').textContent = `${res.servings} főről 2 főre átszámolva${res.guessed ? ' (adagszám nem volt megadva, 4 főt feltételeztem)' : ''}.`;
    updateEdCost();
  }

  /* ---------- események ---------- */
  function setBudget(v, regen) { S.budget = clamp(v); renderBudget(); if (regen) generate(); else renderSummary(); }

  function bind() {
    $('#presets').innerHTML = PRESETS.map(([n, v]) => `<button type="button" data-v="${v}">${n}<small>${(v / 1000).toLocaleString('hu-HU')}e</small></button>`).join('');
    $('#presets').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setBudget(+b.dataset.v, true); });
    $('#budgetRange').addEventListener('input', e => setBudget(e.target.value, false));
    $('#budgetRange').addEventListener('change', e => setBudget(e.target.value, true));
    $('#budgetInput').addEventListener('change', e => setBudget(e.target.value, true));
    $('#budgetInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    document.querySelector('.seg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.dataset.mode === S.mode) return;
      S.mode = b.dataset.mode; save();
      if (costOf(S.menu).value > S.budget) generate(); else renderAll();
    });
    document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; save(); renderTabs(); if (S.tab === 'prices') renderPrices(); } });
    $('#regenBtn').addEventListener('click', generate);
    document.body.addEventListener('click', e => {
      const o = e.target.closest('[data-open]'); if (o) { openRecipe(o.dataset.open); return; }
      const s = e.target.closest('[data-swap]'); if (s) { swapDay(+s.dataset.swap); return; }
      const ed = e.target.closest('[data-edit]'); if (ed) { $('#recipeDlg').close(); openEditor(recipeById(ed.dataset.edit)); }
    });
    $('#shopList').addEventListener('change', e => {
      const pid = e.target.dataset.pantry; if (!pid) return;
      if (e.target.checked) S.pantry.add(pid); else S.pantry.delete(pid);
      save(); renderSummary(); renderShop(); renderDays();
    });
    $('#recipeSearch').addEventListener('input', renderRecipes);
    $('#priceTable').addEventListener('change', e => {
      const pid = e.target.dataset.price; if (!pid) return;
      const v = Math.max(0, Math.round(+e.target.value || 0));
      if (v === P[pid].base) delete S.prices[pid]; else S.prices[pid] = v;
      save(); renderSummary(); renderDays(); renderShop(); renderRecipes(); renderPrices();
    });
    $('#resetPrices').addEventListener('click', () => { S.prices = {}; save(); renderPrices(); renderAll(); toast('Alapárak visszaállítva.'); });
    $('#newRecipeBtn').addEventListener('click', () => openEditor(null));
    $('#edAddIng').addEventListener('click', () => addIngRow(null, null));
    $('#edIngs').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') { e.target.parentElement.remove(); updateEdCost(); } });
    $('#edIngs').addEventListener('change', e => { if (e.target.tagName === 'SELECT') { e.target.parentElement.querySelector('.u').textContent = e.target.value ? P[e.target.value].unit : ''; } updateEdCost(); });
    $('#edIngs').addEventListener('input', updateEdCost);
    $('#edSave').addEventListener('click', saveEditor);
    $('#edDelete').addEventListener('click', deleteEditor);
    $('#wbFetch').addEventListener('click', fetchWikibooks);
    $('#wbParse').addEventListener('click', runImport);
  }

  /* ---------- indulás ---------- */
  bind();
  if (S.menu.length !== 5 || S.menu.some(id => !recipeById(id))) generate(); else renderAll();
  if (S.tab === 'prices') renderPrices();

  // tesztekhez
  window.KK = { parseWikitext, costOf, state: S };
})();
