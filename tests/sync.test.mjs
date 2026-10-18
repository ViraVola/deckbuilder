// Run with: node tests/sync.test.mjs
// Simulates two devices syncing through a fake in-memory GitHub gist API.
import assert from 'node:assert/strict';
import { runSync, planSync, toCompact, fromCompact, signature, FILE, SyncError } from '../src/sync.js';
import { newDeck, addCard, setQty } from '../src/deck.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

// ---- fake GitHub ----
function fakeGitHub(token = 'tok') {
  const gh = { gists: {}, n: 0, calls: [], failNext: null };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    gh.calls.push(`${method} ${u.pathname}`);
    const json = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    if (gh.failNext) { const f = gh.failNext; gh.failNext = null; if (f === 'network') throw new TypeError('Failed to fetch'); return json(f, {}); }
    if ((opts.headers || {}).Authorization !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.pathname === '/gists' && method === 'GET') {
      return json(200, Object.values(gh.gists).map((g) => ({ id: g.id, files: Object.fromEntries(Object.keys(g.files).map((f) => [f, { filename: f }])) })));
    }
    if (u.pathname === '/gists' && method === 'POST') {
      const id = 'g' + ++gh.n;
      gh.gists[id] = { id, public: body.public, files: { ...body.files } };
      return json(201, { id });
    }
    const m = /^\/gists\/(\w+)$/.exec(u.pathname);
    if (m) {
      const g = gh.gists[m[1]];
      if (!g) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, { id: g.id, files: Object.fromEntries(Object.entries(g.files).map(([k, v]) => [k, { filename: k, content: v.content, truncated: false }])) });
      if (method === 'PATCH') { Object.assign(g.files, body.files); return json(200, { id: g.id }); }
    }
    return json(404, {});
  };
  gh.doc = () => JSON.parse(Object.values(gh.gists)[0].files[FILE].content);
  return gh;
}

// Cards known to "Scryfall"
const card = (name) => ({ id: 'id-' + name, oracle_id: 'o-' + name, name, cmc: 1, type_line: 'Instant', color_identity: [], legalities: {}, img: {} });
const fetchCards = async (ids) => ({ found: ids.filter((x) => !x.id.includes('Gone')).map((x) => card(x.id.slice(3))), notFound: [] });

// A "device": its own decks map and sync state.
let clock = 1_000_000;
const now = () => ++clock;
function device(token = 'tok') {
  const d = { decks: {}, state: { token, gistId: '', base: {}, deleted: {}, lastSync: 0 } };
  d.sync = () => runSync({
    state: d.state,
    getDecks: () => d.decks,
    apply: ({ upsert, remove }) => { for (const x of upsert) d.decks[x.id] = x; for (const id of remove) delete d.decks[id]; },
    fetchCards,
    now,
  });
  d.add = (name, cards = []) => { const k = newDeck(name); k.updated = now(); for (const c of cards) addCard(k, card(c)); k.updated = now(); d.decks[k.id] = k; return k; };
  d.edit = (id, fn) => { fn(d.decks[id]); d.decks[id].updated = now(); };
  d.del = (id) => { delete d.decks[id]; d.state.deleted[id] = now(); };
  d.names = () => Object.values(d.decks).map((x) => x.name).sort();
  return d;
}

await test('compact round-trip keeps printings, quantities, zones', () => {
  const k = newDeck('X');
  addCard(k, card('Sol Ring')); addCard(k, card('Island'), 'main', 7); addCard(k, card('Opt'), 'maybe');
  k.commanders.push(card('Crystal'));
  const c = toCompact(k);
  assert.deepEqual(c.main, [['id-Sol Ring', 1], ['id-Island', 7]]);
  const known = new Map(['Sol Ring', 'Island', 'Opt', 'Crystal'].map((n) => [card(n).id, card(n)]));
  const back = fromCompact(c, known);
  assert.equal(back.missing, 0);
  assert.equal(signature(toCompact(back.deck)), signature(c));
  assert.equal(back.deck.commanders[0].name, 'Crystal');
});

await test('plan: one-sided changes, conflicts, tombstones', () => {
  const p = planSync({
    local: { a: { updated: 5, sig: 'A2' }, b: { updated: 3, sig: 'B' }, c: { updated: 9, sig: 'C2' }, d: { updated: 2, sig: 'D' }, e: { updated: 8, sig: 'E' }, new: { updated: 1, sig: 'N' } },
    remote: {
      decks: { a: { updated: 3, sig: 'A' }, b: { updated: 6, sig: 'B2' }, c: { updated: 8, sig: 'C3' }, r: { updated: 4, sig: 'R' }, gone: { updated: 2, sig: 'G' } },
      deleted: { d: 5, e: 7 },
    },
    localDeleted: { gone: 3 },
    base: { a: 3, b: 3, c: 3 },
  });
  assert.deepEqual(p.push.sort(), ['a', 'e', 'new']);      // e was edited after the remote deletion
  assert.deepEqual(p.pull, ['b', 'r']);
  assert.deepEqual(p.conflicts, [{ id: 'c', winner: 'local' }]);
  assert.deepEqual(p.delLocal, ['d']);
  assert.deepEqual(p.delRemote, ['gone']);
});

await test('plan: content differs but neither side has a newer timestamp -> no copy', () => {
  const p = planSync({ local: { x: { updated: 5, sig: 'X1' } }, remote: { decks: { x: { updated: 4, sig: 'X2' } }, deleted: {} }, base: { x: 5 } });
  assert.deepEqual(p.push, ['x']);
  assert.deepEqual(p.conflicts, []);
});

await test('first device creates a private gist; second device gets the decks', async () => {
  const gh = fakeGitHub();
  const pc = device(); const phone = device();
  const k = pc.add('Crystal Spellslinger', ['Sol Ring', 'Opt']);
  await pc.sync();
  assert.equal(Object.keys(gh.gists).length, 1);
  assert.equal(Object.values(gh.gists)[0].public, false);
  assert.ok(gh.doc().decks[k.id]);
  phone.add('Phone deck', ['Island']);
  await phone.sync();                       // finds the existing gist, pulls + pushes
  assert.equal(Object.keys(gh.gists).length, 1);
  assert.deepEqual(phone.names(), ['Crystal Spellslinger', 'Phone deck']);
  assert.equal(phone.decks[k.id].main.length, 2);
  await pc.sync();
  assert.deepEqual(pc.names(), ['Crystal Spellslinger', 'Phone deck']);
});

await test('edits flow both ways; nothing written when nothing changed', async () => {
  const gh = fakeGitHub();
  const pc = device(); const phone = device();
  const k = pc.add('Deck', ['Sol Ring']);
  await pc.sync(); await phone.sync();
  phone.edit(k.id, (d) => addCard(d, card('Brainstorm')));
  await phone.sync(); await pc.sync();
  assert.equal(pc.decks[k.id].main.length, 2);
  pc.edit(k.id, (d) => setQty(d, 'main', 'Sol Ring', 0));
  await pc.sync(); await phone.sync();
  assert.deepEqual(phone.decks[k.id].main.map((e) => e.card.name), ['Brainstorm']);
  const writes = gh.calls.filter((c) => c.startsWith('PATCH')).length;
  await pc.sync(); await phone.sync();
  assert.equal(gh.calls.filter((c) => c.startsWith('PATCH')).length, writes);
});

await test('same deck edited on both devices: newer wins, older kept as a copy', async () => {
  fakeGitHub();
  const pc = device(); const phone = device();
  const k = pc.add('Deck', ['Sol Ring']);
  await pc.sync(); await phone.sync();
  pc.edit(k.id, (d) => addCard(d, card('Opt')));
  phone.edit(k.id, (d) => addCard(d, card('Ponder')));   // later edit -> wins
  await pc.sync();
  const r = await phone.sync();
  assert.equal(r.conflicts, 1);
  await pc.sync();
  for (const dev of [pc, phone]) {
    assert.deepEqual(dev.names(), ['Deck', 'Deck (copy from other device)']);
    assert.ok(dev.decks[k.id].main.some((e) => e.card.name === 'Ponder'));
    const copy = Object.values(dev.decks).find((x) => x.id !== k.id);
    assert.ok(copy.main.some((e) => e.card.name === 'Opt'));
  }
});

await test('deletes spread; a deck edited after deletion comes back', async () => {
  fakeGitHub();
  const pc = device(); const phone = device();
  const a = pc.add('A', ['Opt']); const b = pc.add('B', ['Opt']);
  await pc.sync(); await phone.sync();
  pc.del(a.id);
  await pc.sync(); await phone.sync();
  assert.deepEqual(phone.names(), ['B']);
  pc.del(b.id);
  phone.edit(b.id, (d) => addCard(d, card('Ponder')));   // edited after pc deleted it
  await pc.sync(); await phone.sync(); await pc.sync();
  assert.deepEqual(pc.names(), ['B']);
  assert.deepEqual(phone.names(), ['B']);
});

await test('missing cards are dropped and counted, not fatal', async () => {
  const gh = fakeGitHub();
  const pc = device(); const phone = device();
  pc.add('Deck', ['Opt', 'Gone Card']);
  await pc.sync();
  const r = await phone.sync();
  assert.equal(r.missing, 1);
  assert.equal(Object.values(phone.decks)[0].main.length, 1);
  assert.ok(gh);
});

await test('errors: bad token, offline, deleted gist recreated, damaged file left alone', async () => {
  const gh = fakeGitHub('right');
  const pc = device('wrong');
  pc.add('Deck', ['Opt']);
  await assert.rejects(pc.sync(), (e) => e instanceof SyncError && e.kind === 'auth');
  pc.state.token = 'right';
  gh.failNext = 'network';
  await assert.rejects(pc.sync(), (e) => e.kind === 'network');
  await pc.sync();
  const first = pc.state.gistId;
  delete gh.gists[first];
  await pc.sync();
  assert.notEqual(pc.state.gistId, first);
  assert.equal(Object.keys(gh.gists).length, 1);
  gh.gists[pc.state.gistId].files[FILE] = { content: '{not json' };
  pc.edit(Object.keys(pc.decks)[0], (d) => addCard(d, card('Ponder')));
  await assert.rejects(pc.sync(), (e) => e.kind === 'corrupt');
  assert.equal(gh.gists[pc.state.gistId].files[FILE].content, '{not json');
});

await test('an edit made while a sync is in flight is not overwritten', async () => {
  fakeGitHub();
  const pc = device(); const phone = device();
  const k = pc.add('Deck', ['Opt']);
  await pc.sync(); await phone.sync();
  pc.edit(k.id, (d) => addCard(d, card('Ponder')));
  await pc.sync();
  // phone starts syncing; while card lookups are pending, the user edits the deck
  const slowCards = async (ids) => { phone.edit(k.id, (d) => addCard(d, card('Brainstorm'))); return fetchCards(ids); };
  await runSync({ state: phone.state, getDecks: () => phone.decks, apply: ({ upsert }) => { for (const x of upsert) phone.decks[x.id] = x; }, fetchCards: slowCards, now });
  assert.ok(phone.decks[k.id].main.some((e) => e.card.name === 'Brainstorm'));
  await phone.sync(); await pc.sync();     // next round treats it as a conflict and keeps both
  assert.ok(Object.values(pc.decks).some((d) => d.main.some((e) => e.card.name === 'Brainstorm')));
  assert.ok(Object.values(pc.decks).some((d) => d.main.some((e) => e.card.name === 'Ponder')));
});

console.log(`\n${passed} sync tests passed`);
