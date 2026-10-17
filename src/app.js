import { parseDeckList } from './parser.js';
import { search, resolveEntries } from './scryfall.js';
import {
  FORMATS, formatInfo, newDeck, addCard, setQty, removeCard, moveCard, makeCommander,
  removeCommander, commanderIdentity, commanderCandidates, groupByType, deckCounts,
  issues, toText, deckFromResolved, frontType,
} from './deck.js';
import { expandQuery } from './query.js';
import { VERSION } from './version.js';
import { loadDecks, saveDecks, loadPrefs, savePrefs } from './store.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let decks = loadDecks();
let prefs = loadPrefs();
let deck = null;
const results = { cards: [], total: 0, nextUrl: null, busy: false, query: '' };

// ---------- persistence ----------

let saveTimer = null;
function persist() {
  decks[deck.id] = deck;
  prefs.currentId = deck.id;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!saveDecks(decks)) toast('Could not save: browser storage is full.');
    savePrefs(prefs);
  }, 250);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- small renderers ----------

function pips(cost) {
  if (!cost) return '<span class="cost"></span>';
  return (
    '<span class="cost">' +
    cost.replace(/\{([^}]+)\}/g, (_, sym) => {
      const s = sym.replace('/', '');
      const cls = /^[WUBRGC]$/.test(s) ? s : /^\d+$/.test(s) || s === 'X' ? '' : 'C';
      return `<i class="pip ${cls}">${esc(s.length > 2 ? s[0] : s)}</i>`;
    }) +
    '</span>'
  );
}

const imgOf = (card, size = 'small') => (card.img && (card.img[size] || card.img.normal)) || '';

function cardByName(name) {
  return (
    deck.commanders.find((c) => c.name === name) ||
    (deck.main.find((e) => e.card.name === name) || {}).card ||
    (deck.maybe.find((e) => e.card.name === name) || {}).card
  );
}

const findEntry = (zone, name) => (zone === 'maybe' ? deck.maybe : deck.main).find((e) => e.card.name === name);

// ---------- deck pane ----------

function entryRow(e, zone, problems, showCmd) {
  const warn = problems.get(e.card.name);
  const title = warn ? esc(warn.join(' ')) : '';
  return `<li class="row-item ${warn ? 'warn' : ''}" data-name="${esc(e.card.name)}" data-zone="${zone}" title="${title}">
    <span class="qty">
      <button class="icon" data-act="dec" aria-label="Remove one">−</button>
      <span>${e.qty}</span>
      <button class="icon" data-act="inc" aria-label="Add one">+</button>
    </span>
    <button class="nm" data-act="detail">${esc(e.card.name)}</button>
    ${pips(e.card.mana_cost)}
    <span class="acts">
      ${showCmd ? '<button class="icon" data-act="cmd" title="Make commander">★</button>' : ''}
      <button class="icon" data-act="mv" title="${zone === 'main' ? 'Move to maybeboard' : 'Move to main deck'}">⇄</button>
      <button class="icon" data-act="rm" title="Remove">✕</button>
    </span>
  </li>`;
}

function entryTile(e, zone, problems, showCmd) {
  const warn = problems.get(e.card.name);
  const src = imgOf(e.card);
  return `<div class="tile ${warn ? 'warn' : ''}" data-name="${esc(e.card.name)}" data-zone="${zone}" title="${warn ? esc(warn.join(' ')) : ''}">
    ${src ? `<img loading="lazy" data-act="detail" src="${esc(src)}" alt="${esc(e.card.name)}">` : `<div class="noimg" data-act="detail">${esc(e.card.name)}</div>`}
    <span class="badge">${e.qty}</span>
    <div class="tbar dk">
      <button data-act="dec" aria-label="Remove one">−</button>
      <button data-act="inc" aria-label="Add one">+</button>
      ${showCmd ? '<button data-act="cmd" title="Make commander">★</button>' : ''}
      <button data-act="mv" title="${zone === 'main' ? 'Move to maybeboard' : 'Move to main deck'}">⇄</button>
      <button data-act="rm" title="Remove">✕</button>
    </div>
  </div>`;
}

function commanderZone(fmt) {
  const slots = [0, 1].map((i) => {
    const c = deck.commanders[i];
    if (!c) {
      return `<div class="slot">${i === 0 ? 'Commander' : 'Partner / Background'}<br>(empty)</div>`;
    }
    const src = imgOf(c);
    const picture = prefs.view === 'images' && src ? `<img data-act="detail" src="${esc(src)}" alt="${esc(c.name)}">` : '';
    return `<div class="slot filled" data-name="${esc(c.name)}" data-zone="commander">
      ${picture}
      <div class="slotname"><button class="nm" data-act="detail" style="background:none;border:0;padding:0;font-weight:600;text-align:left">${esc(c.name)}</button>
        <button class="icon" data-act="cmdrm" title="Remove commander (returns it to the main deck)">✕</button></div>
      ${prefs.view === 'list' ? pips(c.mana_cost) : ''}
    </div>`;
  }).join('');
  return `<div class="zone"><h3><span>Commander${deck.commanders.length === 2 ? 's' : ''}</span></h3><div class="cmdslots">${slots}</div></div>`;
}

function renderDeck() {
  const fmt = formatInfo(deck.format);
  const nameInput = $('#deckName');
  if (document.activeElement !== nameInput) nameInput.value = deck.name;
  $('#formatSelect').value = deck.format;

  const counts = deckCounts(deck);
  $('#deckSummary').textContent =
    `${counts.total} cards` +
    (counts.commanders ? ` (${counts.commanders} commander${counts.commanders > 1 ? 's' : ''} + ${counts.main})` : '') +
    (counts.maybe ? ` · ${counts.maybe} in maybeboard` : '');

  const { general, byCard } = issues(deck);
  const flat = [...general];
  for (const [n, msgs] of byCard) for (const m of msgs) flat.push(`${n}: ${m}`);
  $('#deckWarnings').innerHTML = flat.length
    ? `<details><summary>${flat.length} warning${flat.length > 1 ? 's' : ''}</summary><ul>${flat.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`
    : '';

  const hasCmdZone = fmt.singleton || deck.commanders.length > 0;
  const showCmd = hasCmdZone;
  let html = '';

  if (deck.missing && deck.missing.length) {
    html += `<div class="notice">Couldn't match ${deck.missing.length} card${deck.missing.length > 1 ? 's' : ''} from the import: ${esc(deck.missing.join(', '))}. Search for them to add manually.
      <div class="chips"><button data-act="dismiss">Dismiss</button></div></div>`;
  }
  if (hasCmdZone) html += commanderZone(fmt);

  if (hasCmdZone && deck.commanders.length === 0) {
    const cands = commanderCandidates(deck).slice(0, 14);
    if (cands.length) {
      html += `<div class="notice">Pick your commander (tap one, or use ★ on any card):
        <div class="chips">${cands.map((c) => `<button data-act="cmdpick" data-name="${esc(c.name)}">${esc(c.name)}</button>`).join('')}</div></div>`;
    }
  }

  const render = (list, zone) => {
    const groups = groupByType(list);
    return groups
      .map((g) => {
        const body =
          prefs.view === 'images'
            ? `<div class="tiles">${g.entries.map((e) => entryTile(e, zone, byCard, showCmd)).join('')}</div>`
            : `<ul class="rows">${g.entries.map((e) => entryRow(e, zone, byCard, showCmd)).join('')}</ul>`;
        return `<div class="zone"><h3><span>${g.group}</span><span>${g.count}</span></h3>${body}</div>`;
      })
      .join('');
  };

  html += deck.main.length ? render(deck.main, 'main') : '<p class="hint">Empty deck. Search for cards on the right (or the Search tab on a phone), or use Import.</p>';
  if (deck.maybe.length) {
    html += `<h3 style="margin:18px 0 6px;font-size:15px">Maybeboard (${deckCounts(deck).maybe})</h3>` + render(deck.maybe, 'maybe');
  }
  $('#deckBody').innerHTML = html;
}

function renderDeckSelect() {
  const sel = $('#deckSelect');
  const list = Object.values(decks).sort((a, b) => b.updated - a.updated);
  sel.innerHTML = list.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  sel.value = deck.id;
}

function changed() {
  persist();
  renderDeck();
  renderResults();
}

// ---------- search pane ----------

function buildQuery() {
  const parts = [];
  const raw = expandQuery($('#q').value, $('#fTextMode').value);
  if (raw) parts.push(raw);

  let colors = [...document.querySelectorAll('input[name="ci"]:checked')].map((i) => i.value);
  if (colors.length) {
    if (colors.length === 1 && colors[0] === 'c') parts.push('id=c');
    else parts.push(`id${$('#ciMode').value}${colors.filter((c) => c !== 'c').join('')}`);
  }
  const type = $('#fType').value;
  if (type) parts.push(`t:${type}`);
  const mv = $('#fMv').value.trim();
  if (mv) parts.push(/^[<>=!]/.test(mv) ? `mv${mv}` : `mv=${mv}`);
  const legal = $('#fLegal').value;
  if (legal) parts.push(`f:${legal}`);
  const rarity = $('#fRarity').value;
  if (rarity) parts.push(`r:${rarity}`);
  const set = $('#fSet').value.trim();
  if (set) parts.push(`s:${set}`);
  if ($('#fCmdColors').checked) {
    const id = commanderIdentity(deck);
    if (!deck.commanders.length) toast("No commander set, so color limit was skipped.");
    else parts.push(id.length ? `id<=${id.join('').toLowerCase()}` : 'id=c');
  }
  return parts.join(' ');
}

async function runSearch(append = false) {
  if (results.busy) return;
  const status = $('#searchStatus');
  let query = '';
  if (!append) {
    query = buildQuery();
    if (!query) {
      status.className = 'status';
      status.textContent = 'Type a search or pick a filter.';
      return;
    }
    results.cards = [];
    results.total = 0;
    results.nextUrl = null;
    results.query = query;
    $('#searchQuery').textContent = `Scryfall query: ${query}`;
    renderResults();
  }
  results.busy = true;
  status.className = 'status';
  status.textContent = 'Searching…';
  try {
    const res = await search(query, {
      unique: $('#fUnique').value,
      order: $('#fOrder').value,
      nextUrl: append ? results.nextUrl : null,
    });
    results.cards = append ? results.cards.concat(res.cards) : res.cards;
    results.total = res.total;
    results.nextUrl = res.hasMore ? res.nextUrl : null;
    status.textContent = results.cards.length
      ? `Showing ${results.cards.length} of ${results.total}` + (res.warnings.length ? ` · ${res.warnings.join(' ')}` : '')
      : 'No cards found.';
  } catch (err) {
    status.className = 'status err';
    status.textContent = navigator.onLine === false ? 'You appear to be offline.' : String(err.message || err);
  } finally {
    results.busy = false;
    renderResults();
  }
}

function inDeckQty(card) {
  let n = 0;
  for (const e of deck.main) if (e.card.oracle_id === card.oracle_id) n += e.qty;
  for (const c of deck.commanders) if (c.oracle_id === card.oracle_id) n += 1;
  return n;
}

function renderResults() {
  const box = $('#results');
  const cards = results.cards;
  $('#moreBtn').hidden = !results.nextUrl;
  if (!cards.length) {
    box.innerHTML = '';
    return;
  }
  if (prefs.view === 'images') {
    box.innerHTML =
      '<div class="tiles">' +
      cards
        .map((c) => {
          const n = inDeckQty(c);
          const src = imgOf(c);
          return `<div class="tile" data-id="${esc(c.id)}">
            ${src ? `<img loading="lazy" data-act="detail" src="${esc(src)}" alt="${esc(c.name)}">` : `<div class="noimg" data-act="detail">${esc(c.name)}</div>`}
            ${n ? `<span class="badge">${n}</span>` : ''}
            <div class="tbar sr">
              <button class="primary" data-act="add" title="Add to deck">+ Add to deck</button>
              <button data-act="addmaybe" title="Add to maybeboard">Maybe</button>
              <button data-act="addcmd" title="Set as commander">★ Cmdr</button>
            </div>
          </div>`;
        })
        .join('') +
      '</div>';
  } else {
    box.innerHTML =
      '<ul class="rows">' +
      cards
        .map((c) => {
          const n = inDeckQty(c);
          return `<li class="row-item" data-id="${esc(c.id)}">
            <span class="qty"><span>${n || ''}</span></span>
            <button class="nm" data-act="detail">${esc(c.name)} <small style="color:var(--muted)">${esc(frontType(c))}</small></button>
            ${pips(c.mana_cost)}
            <span class="acts">
              <button class="icon" data-act="add" title="Add to deck">+</button>
              <button class="icon" data-act="addmaybe" title="Add to maybeboard">?</button>
              <button class="icon" data-act="addcmd" title="Set as commander">★</button>
            </span>
          </li>`;
        })
        .join('') +
      '</ul>';
  }
}

function onResultsClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const host = el.closest('[data-id]');
  const card = results.cards.find((c) => c.id === host.dataset.id);
  if (!card) return;
  switch (el.dataset.act) {
    case 'add':
      addCard(deck, card, 'main');
      toast(`Added ${card.name}`);
      break;
    case 'addmaybe':
      addCard(deck, card, 'maybe');
      toast(`Added ${card.name} to maybeboard`);
      break;
    case 'addcmd': {
      const res = addCard(deck, card, 'commander');
      toast(res.ok ? `${card.name} is a commander` : res.msg);
      break;
    }
    case 'detail':
      showDetail(card);
      return;
  }
  changed();
}

// ---------- deck pane clicks ----------

function onDeckClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'dismiss') {
    delete deck.missing;
    return changed();
  }
  const host = el.closest('[data-name]');
  const name = host && host.dataset.name;
  const zone = host && host.dataset.zone;
  if (!name) return;
  const entry = zone === 'main' || zone === 'maybe' ? findEntry(zone, name) : null;

  switch (act) {
    case 'inc': setQty(deck, zone, name, entry.qty + 1); break;
    case 'dec': setQty(deck, zone, name, entry.qty - 1); break;
    case 'rm': removeCard(deck, zone, name); break;
    case 'mv': moveCard(deck, name, zone, zone === 'main' ? 'maybe' : 'main'); break;
    case 'cmd':
    case 'cmdpick': {
      const res = makeCommander(deck, name);
      if (!res.ok) toast(res.msg);
      break;
    }
    case 'cmdrm': removeCommander(deck, name); break;
    case 'detail': {
      const card = cardByName(name);
      if (card) showDetail(card);
      return;
    }
  }
  changed();
}

// ---------- card detail ----------

function showDetail(card) {
  const fmt = formatInfo(deck.format);
  const legal = fmt.scry && card.legalities ? card.legalities[fmt.scry] : null;
  const back = card.img_back && card.img_back.normal ? `<img src="${esc(card.img_back.normal)}" alt="${esc(card.name)} (back)">` : '';
  $('#cardDetail').innerHTML = `
    ${imgOf(card, 'normal') ? `<img src="${esc(imgOf(card, 'normal'))}" alt="${esc(card.name)}">` : ''}${back}
    <div class="meta">
      <h2>${esc(card.name)}</h2>
      <div>${pips(card.mana_cost)} ${card.cmc ? `<small>MV ${card.cmc}</small>` : ''}</div>
      <p>${esc(card.type_line)}</p>
      <pre>${esc(card.oracle_text)}</pre>
      <p class="hint">${esc(card.set_name || '')} ${card.set ? `(${esc(card.set.toUpperCase())}) #${esc(card.cn || '')}` : ''}${legal ? ` · ${esc(fmt.label)}: ${esc(legal.replace('_', ' '))}` : ''}</p>
    </div>`;
  $('#cardDialog').showModal();
}

// ---------- import / export ----------

function fillFormatSelects() {
  const opts = FORMATS.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('');
  $('#formatSelect').innerHTML = opts;
  $('#importFormat').innerHTML = opts;
}

async function doImport(ev) {
  ev.preventDefault();
  const status = $('#importStatus');
  const text = $('#importText').value;
  const { entries, unparsed } = parseDeckList(text);
  if (!entries.length) {
    status.className = 'status err';
    status.textContent = 'No cards found in that text.';
    return;
  }
  const go = $('#importGo');
  go.disabled = true;
  status.className = 'status';
  status.textContent = `Looking up ${entries.length} cards…`;
  try {
    const { resolved, missing } = await resolveEntries(entries, (done, total) => {
      status.textContent = `Looking up cards… ${done}/${total}`;
    });
    const name = $('#importName').value.trim() || 'Imported deck';
    const d = deckFromResolved(name, $('#importFormat').value, resolved);
    const lost = [...missing, ...unparsed.map((l) => `"${l}"`)];
    if (lost.length) d.missing = lost;
    decks[d.id] = d;
    deck = d;
    $('#importDialog').close();
    $('#importText').value = '';
    $('#importFile').value = '';
    $('#importName').value = '';
    status.textContent = '';
    renderDeckSelect();
    changed();
    document.body.dataset.pane = 'deck';
    syncNav();
    toast(`Imported ${deckCounts(d).total + deckCounts(d).maybe} cards`);
  } catch (err) {
    status.className = 'status err';
    status.textContent = navigator.onLine === false
      ? 'You appear to be offline. Importing needs an internet connection.'
      : `Import failed: ${err.message || err}`;
  } finally {
    go.disabled = false;
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = $('#exportText');
  ta.select();
  document.execCommand('copy');
  return Promise.resolve();
}

// ---------- wiring ----------

function syncNav() {
  document.querySelectorAll('[data-pane-btn]').forEach((b) => b.classList.toggle('on', b.dataset.paneBtn === document.body.dataset.pane));
}

function switchDeck(id) {
  if (!decks[id]) return;
  deck = decks[id];
  persist();
  renderDeckSelect();
  renderDeck();
  renderResults();
}

function init() {
  fillFormatSelects();
  $('#ver').textContent = VERSION;
  if (!Object.keys(decks).length) {
    const d = newDeck('My first deck', 'commander');
    decks[d.id] = d;
  }
  deck = decks[prefs.currentId] || Object.values(decks).sort((a, b) => b.updated - a.updated)[0];
  $('#viewSelect').value = prefs.view;
  $('#importFormat').value = 'commander';

  $('#deckSelect').addEventListener('change', (e) => switchDeck(e.target.value));
  $('#newDeckBtn').addEventListener('click', () => {
    const name = prompt('Deck name?', 'New deck');
    if (name === null) return;
    const d = newDeck(name.trim() || 'New deck', 'commander');
    decks[d.id] = d;
    switchDeck(d.id);
  });
  $('#deleteDeckBtn').addEventListener('click', () => {
    if (!confirm(`Delete "${deck.name}"? This can't be undone.`)) return;
    delete decks[deck.id];
    if (!Object.keys(decks).length) {
      const d = newDeck('My first deck', 'commander');
      decks[d.id] = d;
    }
    deck = Object.values(decks)[0];
    saveDecks(decks);
    persist();
    renderDeckSelect();
    renderDeck();
    renderResults();
  });
  $('#deckName').addEventListener('input', (e) => {
    deck.name = e.target.value || 'Untitled deck';
    persist();
    renderDeckSelect();
  });
  $('#formatSelect').addEventListener('change', (e) => {
    deck.format = e.target.value;
    changed();
  });
  $('#viewSelect').addEventListener('change', (e) => {
    prefs.view = e.target.value;
    savePrefs(prefs);
    renderDeck();
    renderResults();
  });

  $('#deckBody').addEventListener('click', onDeckClick);
  $('#results').addEventListener('click', onResultsClick);
  const phone = window.matchMedia('(max-width: 899px)');
  if (phone.matches) $('details.filters').open = false;
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (phone.matches) $('details.filters').open = false;
    runSearch(false);
  });
  $('#moreBtn').addEventListener('click', () => runSearch(true));

  // Import
  $('#importBtn').addEventListener('click', () => {
    $('#importStatus').textContent = '';
    $('#importDialog').showModal();
  });
  $('#importCancel').addEventListener('click', () => $('#importDialog').close());
  $('#importForm').addEventListener('submit', doImport);
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#importText').value = await f.text();
    if (!$('#importName').value) $('#importName').value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  });

  // Export
  $('#exportBtn').addEventListener('click', () => {
    $('#exportText').value = toText(deck);
    $('#exportDialog').showModal();
  });
  $('#exportClose').addEventListener('click', () => $('#exportDialog').close());
  $('#exportCopy').addEventListener('click', () => copyText($('#exportText').value).then(() => toast('Copied')));
  $('#exportDownload').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([$('#exportText').value], { type: 'text/plain' }));
    a.download = `${deck.name.replace(/[^\w\- ]+/g, '').trim() || 'deck'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#cardClose').addEventListener('click', () => $('#cardDialog').close());
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }

  document.querySelectorAll('[data-pane-btn]').forEach((b) =>
    b.addEventListener('click', () => {
      document.body.dataset.pane = b.dataset.paneBtn;
      syncNav();
    })
  );

  renderDeckSelect();
  renderDeck();
  renderResults();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
