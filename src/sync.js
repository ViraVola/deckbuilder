// Keeps decks the same on every device by storing them in one private
// ("secret") GitHub gist in the user's own account.
//
// Rules:
// - Decks are compared one at a time, by their "updated" time.
// - A deck changed on only one device since the last sync: that change wins.
// - A deck changed on BOTH devices: the newer one wins and the older one is
//   kept as a separate "(copy from ...)" deck, so nothing is lost silently.
// - Deleting a deck leaves a marker (tombstone) so other devices delete it
//   too, unless they edited it after the deletion.
// - The gist only stores card ids; card details are restored from the other
//   decks on the device or from Scryfall.

import { fetchCollection } from './scryfall.js';
import { newId } from './deck.js';

export const FILE = 'deckbuilder-data.json';
const API = 'https://api.github.com';
const DESCRIPTION = 'Deckbuilder data (written by the Deckbuilder app, please do not edit)';
const TOMBSTONE_DAYS = 90;

export const TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new' +
  '?name=Deckbuilder+sync&description=Lets+the+Deckbuilder+app+sync+decks&expires_in=none&gists=write';

export class SyncError extends Error {
  constructor(message, kind = 'other') {
    super(message);
    this.kind = kind;
  }
}

export const emptyDoc = () => ({ v: 1, decks: {}, deleted: {} });

// ---------- compact deck format ----------

export function toCompact(deck) {
  return {
    id: deck.id,
    name: deck.name,
    format: deck.format,
    updated: deck.updated,
    commanders: deck.commanders.map((c) => c.id),
    main: deck.main.map((e) => [e.card.id, e.qty]),
    maybe: deck.maybe.map((e) => [e.card.id, e.qty]),
  };
}

// Content fingerprint that ignores ordering and the timestamp.
export function signature(c) {
  const norm = (list) => (list || []).map((x) => (Array.isArray(x) ? x.join(':') : String(x))).sort();
  return JSON.stringify([c.name, c.format, norm(c.commanders), norm(c.main), norm(c.maybe)]);
}

export function cardIdsOf(c) {
  return [
    ...(c.commanders || []),
    ...(c.main || []).map((x) => x[0]),
    ...(c.maybe || []).map((x) => x[0]),
  ];
}

// Rebuild a full deck; cards that can't be found are dropped and counted.
export function fromCompact(c, cards) {
  let missing = 0;
  const get = (id) => {
    const card = cards.get(id);
    if (!card) missing++;
    return card;
  };
  const entries = (list) =>
    (list || []).map(([id, qty]) => ({ card: get(id), qty: Number(qty) || 1 })).filter((e) => e.card);
  const deck = {
    id: c.id,
    name: c.name || 'Untitled deck',
    format: c.format || 'commander',
    updated: Number(c.updated) || 0,
    commanders: (c.commanders || []).map(get).filter(Boolean),
    main: entries(c.main),
    maybe: entries(c.maybe),
  };
  return { deck, missing };
}

// ---------- deciding what to do ----------

// local:  { id: { updated, sig } }      remote: { decks: { id: { updated, sig } }, deleted: { id: time } }
// localDeleted: { id: time }            base: { id: updated-at-last-sync }
export function planSync({ local, remote, localDeleted = {}, base = {} }) {
  const plan = { push: [], pull: [], delLocal: [], delRemote: [], conflicts: [], same: [] };
  const remoteDeleted = remote.deleted || {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote.decks)]);
  for (const id of ids) {
    const L = local[id];
    const R = remote.decks[id];
    if (L && R) {
      if (L.sig === R.sig) {
        plan.same.push(id);
        continue;
      }
      const b = base[id];
      const localChanged = b === undefined || L.updated > b;
      const remoteChanged = b === undefined || R.updated > b;
      if (localChanged && !remoteChanged) plan.push.push(id);
      else if (remoteChanged && !localChanged) plan.pull.push(id);
      else if (localChanged && remoteChanged) plan.conflicts.push({ id, winner: L.updated >= R.updated ? 'local' : 'remote' });
      // Content differs but neither timestamp moved (shouldn't happen): newer side wins.
      else if (L.updated >= R.updated) plan.push.push(id);
      else plan.pull.push(id);
    } else if (L) {
      const t = remoteDeleted[id];
      if (t !== undefined && t >= L.updated) plan.delLocal.push(id);
      else plan.push.push(id);
    } else {
      const t = localDeleted[id];
      if (t !== undefined && t >= R.updated) plan.delRemote.push(id);
      else plan.pull.push(id);
    }
  }
  return plan;
}

// ---------- GitHub ----------

async function gh(token, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) {
    throw new SyncError("Couldn't reach GitHub. Are you offline?", 'network');
  }
  if (res.status === 401) {
    throw new SyncError('GitHub rejected the token (it may have expired or been deleted). Make a new one and reconnect.', 'auth');
  }
  if (res.status === 403 || res.status === 429) {
    const left = res.headers && res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || left === '0') throw new SyncError('GitHub is limiting requests right now. It will try again later.', 'rate');
    throw new SyncError('GitHub refused the request. The token may be missing the Gists permission.', 'scope');
  }
  if (res.status === 404) throw new SyncError('Not found on GitHub.', 'notfound');
  if (!res.ok) throw new SyncError(`GitHub error ${res.status}. Try again later.`, 'http');
  return res;
}

export async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await (await gh(token, `/gists?per_page=100&page=${page}`)).json();
    const hit = (list || []).find((g) => g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (!list || list.length < 100) break;
  }
  return '';
}

async function createGist(token, doc) {
  try {
    const res = await gh(token, '/gists', {
      method: 'POST',
      body: { description: DESCRIPTION, public: false, files: { [FILE]: { content: JSON.stringify(doc) } } },
    });
    return (await res.json()).id;
  } catch (e) {
    if (e.kind === 'notfound' || e.kind === 'scope') {
      throw new SyncError('The token isn\'t allowed to create gists. Make a new one using the link in Sync (it sets "Gists: Read and write").', 'scope');
    }
    throw e;
  }
}

function parseDoc(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_) {
    throw new SyncError(
      `The sync file on GitHub is damaged, so nothing was changed. On GitHub, delete the gist named ${FILE}, then press Sync now.`,
      'corrupt'
    );
  }
  if (!doc || typeof doc !== 'object') doc = {};
  if (doc.v > 1) throw new SyncError('The sync file was written by a newer version of the app. Reload to update.', 'version');
  return { v: 1, decks: doc.decks || {}, deleted: doc.deleted || {} };
}

async function readGist(token, id) {
  const g = await (await gh(token, `/gists/${id}`)).json();
  const f = g.files && g.files[FILE];
  if (!f) return emptyDoc();
  let text = f.content;
  if (f.truncated || typeof text !== 'string') {
    let raw;
    try {
      raw = await fetch(f.raw_url, { cache: 'no-store' });
    } catch (_) {
      throw new SyncError("Couldn't reach GitHub. Are you offline?", 'network');
    }
    if (!raw.ok) throw new SyncError(`GitHub error ${raw.status} reading the sync file.`, 'http');
    text = await raw.text();
  }
  return parseDoc(text);
}

async function writeGist(token, id, doc) {
  await gh(token, `/gists/${id}`, { method: 'PATCH', body: { files: { [FILE]: { content: JSON.stringify(doc) } } } });
}

// ---------- one full sync ----------

// state:    { token, gistId, base, deleted, lastSync } (changed in place; save it afterwards)
// getDecks: () => { id: deck }  (the live map)
// apply:    ({ upsert: [deck], remove: [id] }) => void  (write remote changes into the app)
export async function runSync({ state, getDecks, apply, fetchCards = fetchCollection, now = () => Date.now() }) {
  if (!state.token) throw new SyncError('Sync is not connected.', 'auth');
  state.base = state.base || {};
  state.deleted = state.deleted || {};

  // 1. Find and read the gist.
  if (!state.gistId) state.gistId = await findGist(state.token);
  let remote = null;
  if (state.gistId) {
    try {
      remote = await readGist(state.token, state.gistId);
    } catch (e) {
      if (e.kind !== 'notfound') throw e;
      state.gistId = ''; // it was deleted on GitHub; a new one is made below
    }
  }
  const brandNew = !remote;
  if (!remote) remote = emptyDoc();

  // 2. Decide what to do with each deck.
  const before = getDecks();
  const local = {};
  const snapshot = {};
  for (const [id, d] of Object.entries(before)) {
    local[id] = { updated: d.updated, sig: signature(toCompact(d)) };
    snapshot[id] = d.updated;
  }
  const remoteInfo = {};
  for (const [id, c] of Object.entries(remote.decks)) remoteInfo[id] = { updated: Number(c.updated) || 0, sig: signature(c) };
  const plan = planSync({ local, remote: { decks: remoteInfo, deleted: remote.deleted }, localDeleted: state.deleted, base: state.base });

  // 3. Get card details for decks coming from the other device.
  const incoming = [...plan.pull, ...plan.conflicts.map((c) => c.id)];
  const known = new Map();
  for (const d of Object.values(before)) {
    for (const c of d.commanders) known.set(c.id, c);
    for (const e of [...d.main, ...d.maybe]) known.set(e.card.id, e.card);
  }
  const need = new Set();
  for (const id of incoming) for (const cid of cardIdsOf(remote.decks[id])) if (!known.has(cid)) need.add(cid);
  if (need.size) {
    let found;
    try {
      ({ found } = await fetchCards([...need].map((id) => ({ id }))));
    } catch (e) {
      throw new SyncError(`Couldn't load card details from Scryfall (${e.message || e}). Will try again.`, 'network');
    }
    for (const c of found) known.set(c.id, c);
  }

  // 4. Apply changes here. Skip any deck edited while we were waiting on the network.
  const current = getDecks();
  const untouched = (id) => current[id] && current[id].updated === snapshot[id];
  const upsert = [];
  const remove = [];
  const copies = [];
  const pushIds = new Set(plan.push);
  let missing = 0;
  let pulled = 0;
  let conflicts = 0;

  const copyOf = (d, where) => ({
    ...d,
    id: newId(),
    name: `${d.name} (copy from ${where})`,
    updated: now(),
    commanders: [...d.commanders],
    main: d.main.map((e) => ({ ...e })),
    maybe: d.maybe.map((e) => ({ ...e })),
  });

  for (const id of plan.pull) {
    if (current[id] && !untouched(id)) continue;
    const r = fromCompact(remote.decks[id], known);
    missing += r.missing;
    upsert.push(r.deck);
    state.base[id] = r.deck.updated;
    delete state.deleted[id];
    pulled++;
  }
  for (const id of plan.delLocal) {
    if (!untouched(id)) continue;
    remove.push(id);
    delete state.base[id];
  }
  for (const { id, winner } of plan.conflicts) {
    if (!untouched(id)) continue;
    conflicts++;
    const r = fromCompact(remote.decks[id], known);
    missing += r.missing;
    if (winner === 'remote') {
      copies.push(copyOf(current[id], 'this device'));
      upsert.push(r.deck);
      state.base[id] = r.deck.updated;
    } else {
      copies.push(copyOf(r.deck, 'other device'));
      pushIds.add(id);
    }
  }
  if (upsert.length || remove.length || copies.length) apply({ upsert: [...upsert, ...copies], remove });

  // 5. Build the new gist contents and save it if anything changed.
  const after = getDecks();
  const outDecks = { ...remote.decks };
  const outDeleted = { ...remote.deleted };
  const pushedBase = {};
  for (const id of [...pushIds, ...copies.map((c) => c.id)]) {
    const d = after[id];
    if (!d) continue;
    outDecks[id] = toCompact(d);
    delete outDeleted[id];
    pushedBase[id] = d.updated;
  }
  for (const id of plan.delRemote) {
    delete outDecks[id];
    outDeleted[id] = state.deleted[id];
  }
  const cutoff = now() - TOMBSTONE_DAYS * 86400000;
  for (const id of Object.keys(outDeleted)) if (!(outDeleted[id] >= cutoff)) delete outDeleted[id];
  for (const id of Object.keys(state.deleted)) if (!(state.deleted[id] >= cutoff)) delete state.deleted[id];

  const changed =
    brandNew ||
    JSON.stringify(outDecks) !== JSON.stringify(remote.decks) ||
    JSON.stringify(outDeleted) !== JSON.stringify(remote.deleted);
  if (changed) {
    const doc = { v: 1, decks: outDecks, deleted: outDeleted };
    if (!state.gistId) state.gistId = await createGist(state.token, doc);
    else await writeGist(state.token, state.gistId, doc);
  }

  // 6. Remember what was synced.
  Object.assign(state.base, pushedBase);
  for (const id of plan.same) {
    if (local[id] && remoteInfo[id]) state.base[id] = Math.max(local[id].updated, remoteInfo[id].updated);
  }
  for (const id of plan.delRemote) delete state.base[id];
  state.lastSync = now();
  return { pulled, pushed: Object.keys(pushedBase).length, removed: remove.length + plan.delRemote.length, conflicts, missing };
}
