import { parseDeckList } from './parser.js';
import { search, resolveEntries, printingsOf, pause } from './scryfall.js';
import {
  FORMATS, formatInfo, newDeck, addCard, setQty, removeCard, moveCard, makeCommander,
  removeCommander, commanderIdentity, commanderCandidates, groupByType, deckCounts,
  issues, toText, deckFromResolved, frontType, swapPrinting,
} from './deck.js';
import { defaultArt, choosePrintings, favoriteOf, ruleQuery, ruleMatches, imageUrl, PREFER_OPTIONS } from './art.js';
import { expandQuery } from './query.js';
import { VERSION } from './version.js';
import { loadArtPrefs, saveArtPrefs, loadDecks, saveDecks, loadPrefs, savePrefs, loadSync, saveSync, requestPersistence } from './store.js';
import { runSync, SyncError, TOKEN_URL } from './sync.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let decks = loadDecks();
let prefs = loadPrefs();
let deck = null;
let sync = loadSync();
let artPrefs = loadArtPrefs(defaultArt());
const syncUi = { running: false, again: false, timer: null, error: '', kind: '' };
const results = { cards: [], total: 0, nextUrl: null, busy: false, query: '', display: new Map(), ruleCache: {}, token: 0 };

// ---------- persistence ----------

let saveTimer = null;
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Every change is saved on this device right away (a quarter second later at
// most, and immediately if the app is closed or put in the background).
function persist() {
  decks[deck.id] = deck;
  prefs.currentId = deck.id;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!deck) return;
  decks[deck.id] = deck;
  const ok = saveDecks(decks) && savePrefs(prefs);
  const info = $('#saveInfo');
  info.textContent = ok ? 'Saved' : '⚠ Not saved';
  info.classList.toggle('bad', !ok);
  info.title = ok ? `Saved on this device at ${timeOf(Date.now())}` : 'Browser storage is full or blocked, so changes are not being saved.';
  if (!ok) toast('Could not save: browser storage is full or blocked.');
}

// A real edit: save it, and send it to the other devices shortly.
function edited() {
  if (deck.starter) delete deck.starter;
  persist();
  scheduleSync(4000);
}

// ---------- sync between devices ----------

// The empty deck a new device starts with isn't worth syncing.
function starterDeck() {
  const d = newDeck('My first deck', 'commander');
  d.starter = true;
  return d;
}
const isBlankStarter = (d) => d.starter && !d.main.length && !d.maybe.length && !d.commanders.length;
const syncableDecks = () => Object.fromEntries(Object.entries(decks).filter(([, d]) => !isBlankStarter(d)));

function scheduleSync(ms = 4000) {
  if (!sync.token) return;
  clearTimeout(syncUi.timer);
  syncUi.timer = setTimeout(() => doSync(false), ms);
}

// Put decks that arrived from another device into the app.
function applyRemote({ upsert = [], remove = [] }) {
  for (const d of upsert) decks[d.id] = d;
  for (const id of remove) delete decks[id];
  if (upsert.length) for (const [id, d] of Object.entries(decks)) if (isBlankStarter(d)) delete decks[id];
  if (!Object.keys(decks).length) {
    const d = starterDeck();
    decks[d.id] = d;
  }
  deck = decks[deck.id] || Object.values(decks).sort((a, b) => b.updated - a.updated)[0];
  flush();
  renderDeckSelect();
  renderDeck();
  renderResults();
}

async function doSync(manual) {
  if (!sync.token) return;
  if (syncUi.running) {
    syncUi.again = true;
    return;
  }
  clearTimeout(syncUi.timer);
  if (saveTimer) flush();
  syncUi.running = true;
  renderSync();
  try {
    const r = await runSync({ state: sync, getDecks: syncableDecks, apply: applyRemote, getSettings: () => artPrefs, applySettings: applyRemoteArt });
    syncUi.error = '';
    syncUi.kind = '';
    const notes = [];
    if (r.conflicts) notes.push(`${r.conflicts} deck${r.conflicts > 1 ? 's were' : ' was'} changed on two devices, so both versions were kept`);
    if (r.missing) notes.push(`${r.missing} card${r.missing > 1 ? 's' : ''} couldn't be restored`);
    if (notes.length) toast(notes.join('. ') + '.');
    else if (manual) toast(r.pulled ? `Synced: ${r.pulled} deck${r.pulled > 1 ? 's' : ''} updated` : 'Synced');
  } catch (err) {
    syncUi.error = err instanceof SyncError ? err.message : `Sync failed: ${err.message || err}`;
    syncUi.kind = err.kind || 'other';
    if (manual || ['auth', 'scope', 'corrupt'].includes(syncUi.kind)) toast(syncUi.error);
  } finally {
    saveSync(sync);
    syncUi.running = false;
    renderSync();
    if (syncUi.again) {
      syncUi.again = false;
      scheduleSync(1500);
    }
  }
}

// Favorites / art rules that arrived from another device.
function applyRemoteArt({ favs = {}, art = null }) {
  for (const [k, f] of Object.entries(favs)) {
    const cur = artPrefs.favs[k];
    if (!cur || f.t > cur.t) artPrefs.favs[k] = f;
  }
  if (art && (art.t || 0) > (artPrefs.art.t || 0)) artPrefs.art = art;
  saveArtPrefs(artPrefs);
  refreshFavoritesInResults();
}

function saveArt() {
  saveArtPrefs(artPrefs);
  scheduleSync(3000);
}

function renderSync() {
  const b = $('#syncBtn');
  b.classList.remove('ok', 'bad');
  if (!sync.token) {
    b.textContent = 'Sync: off';
    b.title = 'Keep your decks the same on phone and PC';
  } else if (syncUi.running) {
    b.textContent = 'Syncing…';
  } else if (syncUi.error) {
    b.textContent = syncUi.kind === 'network' ? 'Sync: offline' : 'Sync problem';
    b.classList.add('bad');
    b.title = syncUi.error;
  } else {
    b.textContent = sync.lastSync ? `Synced ${timeOf(sync.lastSync)}` : 'Sync: on';
    b.classList.add('ok');
    b.title = 'Decks sync automatically. Click for options.';
  }

  $('#syncSetup').hidden = !!sync.token;
  $('#syncOn').hidden = !sync.token;
  $('#syncStatusText').textContent = !sync.token
    ? ''
    : syncUi.running
      ? 'Syncing now…'
      : `Sync is on for this device. ${sync.lastSync ? `Last synced at ${timeOf(sync.lastSync)}.` : 'Not synced yet.'} Changes are sent a few seconds after you make them, and other devices' changes arrive when you open the app.`;
  const msg = $('#syncMsg');
  msg.textContent = syncUi.error;
  msg.className = syncUi.error ? 'status err' : 'status';
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

const imgOf = (card, size = 'normal') => imageUrl(card, size);

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
  edited();
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
  if (artPrefs.art.prefer && $('#fUnique').value === 'cards' && !/\bprefer:/.test(raw)) parts.push(`prefer:${artPrefs.art.prefer}`);
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
    if (!append) {
      results.display = new Map();
      results.ruleCache = {};
    }
    upgradeArt(++results.token);
  } catch (err) {
    status.className = 'status err';
    status.textContent = navigator.onLine === false ? 'You appear to be offline.' : String(err.message || err);
  } finally {
    results.busy = false;
    renderResults();
  }
}

// ---------- preferred artwork in search results ----------

const shown = (c) => (results.display.get(c.oracle_id) || {}).card || c;

function refreshFavoritesInResults() {
  for (const c of results.cards) {
    const fav = favoriteOf(artPrefs.favs, c.oracle_id);
    const cur = results.display.get(c.oracle_id);
    if (fav) results.display.set(c.oracle_id, { card: fav, why: 'Your favorite printing' });
    else if (cur && cur.why === 'Your favorite printing') results.display.delete(c.oracle_id);
  }
  renderResults();
}

// Show favorites straight away, then look for printings that match your art
// rules (one extra Scryfall search per rule, only for cards still needing one).
async function upgradeArt(token) {
  refreshFavoritesInResults();
  if ($('#fUnique').value !== 'cards' || !results.cards.length) return;
  const rules = artPrefs.art.rules.filter((r) => r.on);
  const found = new Map();
  const order = $('#fOrder').value;
  const needs = () => results.cards.filter((c) => !results.display.has(c.oracle_id));
  for (const rule of rules) {
    if (!needs().length) break;
    const cache = (results.ruleCache[rule.id] = results.ruleCache[rule.id] || { map: new Map(), next: null, pages: 0 });
    try {
      while (cache.pages < 3 && (cache.pages === 0 || cache.next) && needs().some((c) => !cache.map.has(c.oracle_id))) {
        const res = await search(ruleQuery(results.query, rule), { unique: 'prints', order, nextUrl: cache.next });
        if (token !== results.token) return;
        cache.pages++;
        cache.next = res.hasMore ? res.nextUrl : null;
        for (const p of res.cards) {
          if (!cache.map.has(p.oracle_id)) cache.map.set(p.oracle_id, []);
          cache.map.get(p.oracle_id).push(p);
        }
        await pause(100);
      }
    } catch (_) {
      continue; // a rule that fails (bad filter, offline) is just skipped
    }
    found.set(rule.id, cache.map);
    const picks = choosePrintings(needs(), found, [rule]);
    for (const [oid, pick] of picks) results.display.set(oid, { card: pick.card, why: `Art rule: ${pick.rule}` });
    if (token !== results.token) return;
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
        .map((base) => {
          const c = shown(base);
          const why = (results.display.get(base.oracle_id) || {}).why;
          const n = inDeckQty(c);
          const src = imgOf(c);
          return `<div class="tile" data-id="${esc(base.id)}" title="${esc(`${c.set_name || ''} (${(c.set || '').toUpperCase()}) #${c.cn || ''}${why ? ' · ' + why : ''}`)}">
            ${why ? `<span class="arttag">${why.startsWith('Your') ? '★' : 'art'}</span>` : ''}
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
        .map((base) => {
          const c = shown(base);
          const n = inDeckQty(c);
          return `<li class="row-item" data-id="${esc(base.id)}">
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
  const base = results.cards.find((c) => c.id === host.dataset.id);
  if (!base) return;
  const card = shown(base);
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

// The card currently shown in the pop-up, and its printings once loaded.
const detail = { card: null, prints: [], next: null, loading: false };

const deckHas = (oracleId) =>
  deck.commanders.some((c) => c.oracle_id === oracleId) ||
  [...deck.main, ...deck.maybe].some((e) => e.card.oracle_id === oracleId);
const deckPrinting = (oracleId) =>
  deck.commanders.find((c) => c.oracle_id === oracleId) ||
  ([...deck.main, ...deck.maybe].find((e) => e.card.oracle_id === oracleId) || {}).card;

function showDetail(card, keepPrints = false) {
  if (!keepPrints || !detail.card || detail.card.oracle_id !== card.oracle_id) {
    detail.prints = [];
    detail.next = null;
  }
  detail.card = card;
  renderDetail();
  if (!$('#cardDialog').open) $('#cardDialog').showModal();
}

function renderDetail() {
  const card = detail.card;
  const fmt = formatInfo(deck.format);
  const legal = fmt.scry && card.legalities ? card.legalities[fmt.scry] : null;
  const fav = favoriteOf(artPrefs.favs, card.oracle_id);
  const isFav = fav && fav.id === card.id;
  const inDeck = deckHas(card.oracle_id);
  const usedHere = inDeck && (deckPrinting(card.oracle_id) || {}).id === card.id;
  const backSrc = imageUrl(card, 'large', true);
  const back = backSrc ? `<img src="${esc(backSrc)}" alt="${esc(card.name)} (back)">` : '';
  $('#cardDetail').innerHTML = `
    ${imgOf(card, 'large') ? `<img src="${esc(imgOf(card, 'large'))}" alt="${esc(card.name)}">` : ''}${back}
    <div class="meta">
      <h2>${esc(card.name)}</h2>
      <div>${pips(card.mana_cost)} ${card.cmc ? `<small>MV ${card.cmc}</small>` : ''}</div>
      <p>${esc(card.type_line)}</p>
      <pre>${esc(card.oracle_text)}</pre>
      <p class="hint">${esc(card.set_name || '')} ${card.set ? `(${esc(card.set.toUpperCase())}) #${esc(card.cn || '')}` : ''}${card.lang && card.lang !== 'en' ? ` · ${esc(card.lang.toUpperCase())}` : ''}${legal ? ` · ${esc(fmt.label)}: ${esc(legal.replace('_', ' '))}` : ''}</p>
      <div class="chips">
        <button data-dact="fav" class="${isFav ? 'primary' : ''}">${isFav ? '★ Favorite printing' : '☆ Make this my favorite printing'}</button>
        ${inDeck ? `<button data-dact="use" ${usedHere ? 'disabled' : ''}>${usedHere ? 'Used in this deck' : 'Use this printing in this deck'}</button>` : ''}
        ${detail.prints.length ? '' : '<button data-dact="prints">Show all printings</button>'}
      </div>
      ${fav && !isFav ? `<p class="hint">Your favorite is ${esc(fav.set_name || '')} #${esc(fav.cn || '')}.</p>` : ''}
    </div>`;
  renderPrintings();
}

function renderPrintings() {
  const box = $('#printings');
  if (detail.loading && !detail.prints.length) {
    box.innerHTML = '<p class="hint">Loading printings…</p>';
    return;
  }
  if (!detail.prints.length) {
    box.innerHTML = '';
    return;
  }
  const fav = favoriteOf(artPrefs.favs, detail.card.oracle_id);
  box.innerHTML =
    `<h3 class="ptitle">${detail.prints.length} printing${detail.prints.length > 1 ? 's' : ''} · tap one to view it</h3><div class="tiles ptiles">` +
    detail.prints
      .map((p) => `<div class="tile ${p.id === detail.card.id ? 'sel' : ''}" data-pid="${esc(p.id)}">
        <img loading="lazy" data-dact="view" src="${esc(imgOf(p))}" alt="${esc(p.set_name || p.set)}">
        ${fav && fav.id === p.id ? '<span class="arttag">★</span>' : ''}
        <div class="pcap">${esc((p.set || '').toUpperCase())} #${esc(p.cn || '')}${p.lang !== 'en' ? ' · ' + esc(p.lang.toUpperCase()) : ''}</div>
      </div>`)
      .join('') +
    '</div>' +
    (detail.next ? '<button data-dact="more" class="pmore">More printings</button>' : '');
}

async function loadPrintings(more = false) {
  if (detail.loading) return;
  detail.loading = true;
  renderPrintings();
  try {
    const res = await printingsOf(detail.card.oracle_id, more ? detail.next : null);
    detail.prints = more ? detail.prints.concat(res.cards) : res.cards;
    detail.next = res.hasMore ? res.nextUrl : null;
  } catch (err) {
    toast(`Couldn't load printings: ${err.message || err}`);
  } finally {
    detail.loading = false;
    renderDetail();
  }
}

function onDetailClick(e) {
  const el = e.target.closest('[data-dact]');
  if (!el) return;
  const card = detail.card;
  switch (el.dataset.dact) {
    case 'prints':
      loadPrintings(false);
      return;
    case 'more':
      loadPrintings(true);
      return;
    case 'view': {
      const p = detail.prints.find((x) => x.id === el.closest('[data-pid]').dataset.pid);
      if (p) showDetail(p, true);
      $('#cardDialog').scrollTop = 0;
      return;
    }
    case 'fav': {
      const fav = favoriteOf(artPrefs.favs, card.oracle_id);
      const on = !(fav && fav.id === card.id);
      artPrefs.favs[card.oracle_id] = { card: on ? card : null, t: Date.now() };
      saveArt();
      toast(on ? 'Favorite printing saved. It will show in searches.' : 'Favorite removed.');
      refreshFavoritesInResults();
      renderDetail();
      return;
    }
    case 'use': {
      const current = deckPrinting(card.oracle_id);
      if (!current) return;
      swapPrinting(deck, current.name, card);
      changed();
      renderDetail();
      toast('Printing changed in this deck.');
      return;
    }
  }
}

// ---------- art preferences ----------

function renderArtDialog() {
  const rules = artPrefs.art.rules;
  $('#artRules').innerHTML = rules
    .map((r, i) => `<li data-i="${i}">
      <label class="rulehead"><input type="checkbox" data-aact="toggle" ${r.on ? 'checked' : ''}> ${esc(r.label)}</label>
      <code>${esc(r.query)}${r.test ? ' + extra check' : ''}</code>
      <span class="ruleacts">
        <button class="icon" data-aact="up" ${i === 0 ? 'disabled' : ''} title="Higher priority">↑</button>
        <button class="icon" data-aact="down" ${i === rules.length - 1 ? 'disabled' : ''} title="Lower priority">↓</button>
        <button data-aact="check">Check</button>
        <button class="icon" data-aact="del" title="Remove rule">✕</button>
      </span>
      <div class="rulemsg status"></div>
    </li>`)
    .join('');
  $('#artPrefer').innerHTML = PREFER_OPTIONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  $('#artPrefer').value = artPrefs.art.prefer || '';
  const nFav = Object.values(artPrefs.favs).filter((f) => f.card).length;
  $('#artFavCount').textContent = `${nFav} favorite printing${nFav === 1 ? '' : 's'} saved.`;
}

function artChanged() {
  artPrefs.art.t = Date.now();
  saveArt();
  renderArtDialog();
}

async function onArtClick(e) {
  const el = e.target.closest('[data-aact]');
  if (!el) return;
  const li = el.closest('[data-i]');
  const i = li ? Number(li.dataset.i) : -1;
  const rules = artPrefs.art.rules;
  switch (el.dataset.aact) {
    case 'toggle':
      rules[i].on = el.checked;
      return artChanged();
    case 'up':
      [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
      return artChanged();
    case 'down':
      [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
      return artChanged();
    case 'del':
      if (!confirm(`Remove the rule "${rules[i].label}"?`)) return;
      rules.splice(i, 1);
      return artChanged();
    case 'check': {
      const rule = rules[i];
      const msg = li.querySelector('.rulemsg');
      msg.className = 'rulemsg status';
      msg.textContent = 'Checking…';
      try {
        const res = await search(rule.query, { unique: 'prints', order: 'released' });
        const ok = res.cards.filter((c) => ruleMatches(rule, c, null));
        const names = [...new Set(ok.map((c) => c.name))].slice(0, 5);
        msg.textContent = ok.length
          ? `Matches${rule.test ? ` ${ok.length} of the newest ${res.cards.length}` : ` ${res.total}`} printings, e.g. ${names.join(', ')}.`
          : res.total
            ? `Scryfall found ${res.total} printings, but none passed the extra check in the newest ${res.cards.length}.`
            : 'No printings match this rule.';
      } catch (err) {
        msg.className = 'rulemsg status err';
        msg.textContent = `Scryfall didn't accept this filter: ${err.message || err}`;
      }
      return;
    }
    case 'add': {
      const label = $('#artNewLabel').value.trim();
      const query = $('#artNewQuery').value.trim();
      if (!query) return toast('Type a Scryfall filter for the rule, e.g. s:sld');
      rules.push({ id: 'r' + Date.now().toString(36), label: label || query, query, on: true });
      $('#artNewLabel').value = '';
      $('#artNewQuery').value = '';
      return artChanged();
    }
    case 'reset':
      if (!confirm('Reset the art rules to the starting set?')) return;
      artPrefs.art = { ...defaultArt(), prefer: artPrefs.art.prefer };
      return artChanged();
    case 'clearfavs':
      if (!confirm('Forget all your favorite printings?')) return;
      for (const k of Object.keys(artPrefs.favs)) artPrefs.favs[k] = { card: null, t: Date.now() };
      saveArt();
      refreshFavoritesInResults();
      return renderArtDialog();
  }
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
    const start = text.trim().split('\n')[0] || '';
    status.textContent = text.trim()
      ? `No cards found. The text starts with: "${start.slice(0, 60)}"`
      : 'Choose a file or paste a decklist first.';
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

// Reads a deck file as text. Handles UTF-8 and UTF-16 (some Windows tools
// save that way), and doesn't care what the file extension is.
async function readFileText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let enc = 'utf-8';
  if (buf[0] === 0xff && buf[1] === 0xfe) enc = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) enc = 'utf-16be';
  return new TextDecoder(enc).decode(buf);
}

async function loadImportFile(f) {
  if (!f) return;
  const status = $('#importStatus');
  try {
    const text = await readFileText(f);
    $('#importText').value = text;
    if (!$('#importName').value) $('#importName').value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    const n = parseDeckList(text).entries.length;
    status.className = n ? 'status' : 'status err';
    status.textContent = n
      ? `Loaded ${f.name} (${n} different cards). Click Import.`
      : `Loaded ${f.name}, but couldn't find any cards in it.`;
  } catch (err) {
    status.className = 'status err';
    status.textContent = `Couldn't read ${f.name}: ${err.message || err}`;
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
    const d = starterDeck();
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
    scheduleSync(4000);
  });
  $('#deleteDeckBtn').addEventListener('click', () => {
    if (!confirm(`Delete "${deck.name}"? This can't be undone.`)) return;
    delete decks[deck.id];
    sync.deleted[deck.id] = Date.now();
    saveSync(sync);
    if (!Object.keys(decks).length) {
      const d = starterDeck();
      decks[d.id] = d;
    }
    deck = Object.values(decks)[0];
    flush();
    renderDeckSelect();
    renderDeck();
    renderResults();
    scheduleSync(1500);
  });
  $('#deckName').addEventListener('input', (e) => {
    deck.name = e.target.value || 'Untitled deck';
    deck.updated = Date.now();
    edited();
    renderDeckSelect();
  });
  $('#formatSelect').addEventListener('change', (e) => {
    deck.format = e.target.value;
    deck.updated = Date.now();
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
  $('#importFile').addEventListener('change', (e) => loadImportFile(e.target.files[0]));
  const dlg = $('#importDialog');
  dlg.addEventListener('dragover', (e) => { e.preventDefault(); dlg.classList.add('dragging'); });
  dlg.addEventListener('dragleave', (e) => { if (e.target === dlg) dlg.classList.remove('dragging'); });
  dlg.addEventListener('drop', (e) => {
    e.preventDefault();
    dlg.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImportFile(f);
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
  $('#cardDialog').addEventListener('click', onDetailClick);
  $('#artBtn').addEventListener('click', () => {
    renderArtDialog();
    $('#artDialog').showModal();
  });
  $('#artDialog').addEventListener('click', onArtClick);
  $('#artPrefer').addEventListener('change', (e) => {
    artPrefs.art.prefer = e.target.value;
    artChanged();
  });
  $('#artClose').addEventListener('click', () => $('#artDialog').close());
  // Tapping outside a pop-up closes it (but not tapping its own padding).
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) d.close();
    });
  }

  document.querySelectorAll('[data-pane-btn]').forEach((b) =>
    b.addEventListener('click', () => {
      document.body.dataset.pane = b.dataset.paneBtn;
      syncNav();
    })
  );

  // Sync dialog
  $('#syncTokenLink').href = TOKEN_URL;
  $('#syncBtn').addEventListener('click', () => {
    renderSync();
    $('#syncDialog').showModal();
  });
  $('#syncClose').addEventListener('click', () => $('#syncDialog').close());
  $('#syncConnect').addEventListener('click', async () => {
    const token = $('#syncToken').value.trim();
    if (!token) {
      syncUi.error = 'Paste your token first.';
      renderSync();
      return;
    }
    sync = { ...sync, token, gistId: '', base: {}, lastSync: 0 };
    $('#syncToken').value = '';
    syncUi.error = '';
    await doSync(true);
    if (['auth', 'scope'].includes(syncUi.kind)) {
      sync.token = ''; // didn't work: go back to the setup steps, keep the message
      saveSync(sync);
    }
    renderSync();
  });
  $('#syncNow').addEventListener('click', () => doSync(true));
  $('#syncDisconnect').addEventListener('click', () => {
    if (!confirm('Stop syncing on this device? Your decks stay here and on GitHub.')) return;
    sync = { ...sync, token: '', gistId: '', base: {}, lastSync: 0 };
    syncUi.error = '';
    saveSync(sync);
    renderSync();
  });

  // Save immediately when the app is hidden or closed; check for other
  // devices' changes when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else scheduleSync(300);
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('online', () => scheduleSync(500));
  setInterval(() => {
    if (document.visibilityState === 'visible') scheduleSync(0);
  }, 120000);

  renderDeckSelect();
  renderDeck();
  renderResults();
  renderSync();
  requestPersistence();
  $('#saveInfo').textContent = 'Saved';
  $('#saveInfo').title = 'Your decks are saved on this device automatically.';
  scheduleSync(300);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
