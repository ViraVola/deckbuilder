// Run with: node tests/art.test.mjs
import assert from 'node:assert/strict';
import { TESTS, DEFAULT_RULES, choosePrintings, bestOf, ruleQuery, imageUrl, favoriteOf } from '../src/art.js';
import { runSync } from '../src/sync.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

const p = (o) => ({ oracle_id: 'o1', name: 'Counterspell', lang: 'en', promo: false, promo_types: [], frame_effects: [], full_art: false, illustration_id: 'ill-default', released: '2020-01-01', ...o });

await test('Japanese Mystical Archive = STA #64 and up only', () => {
  assert.equal(TESTS.jpArchive(p({ set: 'sta', cn: '70' })), true);
  assert.equal(TESTS.jpArchive(p({ set: 'sta', cn: '64' })), true);
  assert.equal(TESTS.jpArchive(p({ set: 'sta', cn: '15' })), false);
  assert.equal(TESTS.jpArchive(p({ set: 'stx', cn: '70' })), false);
});

await test('Japan-exclusive promos: Japanese promo with different art (or JP walker)', () => {
  const base = p({});
  assert.equal(TESTS.jpPromo(p({ lang: 'ja', promo: true, illustration_id: 'ill-jp' }), base), true);
  assert.equal(TESTS.jpPromo(p({ lang: 'ja', promo: true }), base), false); // same art as normal
  assert.equal(TESTS.jpPromo(p({ lang: 'ja', promo_types: ['jpwalker'] }), base), true);
  assert.equal(TESTS.jpPromo(p({ lang: 'en', promo: true, illustration_id: 'x' }), base), false);
  assert.equal(TESTS.jpPromo(p({ lang: 'ja', promo: false, illustration_id: 'x' }), base), false);
});

await test('full-art / extended-art promos only', () => {
  assert.equal(TESTS.fullOrExtendedPromo(p({ promo: true, full_art: true })), true);
  assert.equal(TESTS.fullOrExtendedPromo(p({ promo: true, frame_effects: ['extendedart'] })), true);
  assert.equal(TESTS.fullOrExtendedPromo(p({ promo: true })), false);
  assert.equal(TESTS.fullOrExtendedPromo(p({ full_art: true })), false);
});

await test('rules apply in priority order; first rule with a match wins', () => {
  const base = [p({ oracle_id: 'a', illustration_id: 'i-a' }), p({ oracle_id: 'b' }), p({ oracle_id: 'c' })];
  const found = new Map([
    ['jp-archive', new Map([['a', [p({ oracle_id: 'a', set: 'sta', cn: '80' })]], ['b', [p({ oracle_id: 'b', set: 'sta', cn: '5' })]]])],
    ['jp-promo', new Map([['a', [p({ oracle_id: 'a', lang: 'ja', promo: true, illustration_id: 'jp' })]]])],
    ['full-ext-promo', new Map([['b', [p({ oracle_id: 'b', set: 'pxx', promo: true, full_art: true })]], ['c', [p({ oracle_id: 'c', promo: true })]]])],
  ]);
  const picks = choosePrintings(base, found, DEFAULT_RULES);
  assert.equal(picks.get('a').card.set, 'sta');          // rule 1 beats rule 2
  assert.equal(picks.get('b').card.set, 'pxx');          // STA #5 isn't Japanese -> falls to rule 3
  assert.equal(picks.has('c'), false);                   // plain promo isn't full/extended art
  const off = DEFAULT_RULES.map((r) => ({ ...r, on: r.id !== 'jp-archive' }));
  assert.equal(choosePrintings(base, found, off).get('a').card.lang, 'ja');
});

await test('best of several matches: English first, then newest', () => {
  const pick = bestOf([p({ id: 1, lang: 'ja', released: '2024-01-01' }), p({ id: 2, released: '2019-01-01' }), p({ id: 3, released: '2022-01-01' })]);
  assert.equal(pick.id, 3);
});

await test('rule query wraps your search and drops prefer:', () => {
  assert.equal(ruleQuery('(name:"bolt" or o:"bolt") id<=r prefer:oldest', DEFAULT_RULES[0]), '((name:"bolt" or o:"bolt") id<=r) (s:sta)');
  assert.equal(ruleQuery('', DEFAULT_RULES[0]), 's:sta');
});

await test('image sizes: stored size used, otherwise derived from the URL', () => {
  const card = { img: { small: 'https://cards.scryfall.io/small/front/a/b/x.jpg?1', normal: 'https://cards.scryfall.io/normal/front/a/b/x.jpg?1' } };
  assert.equal(imageUrl(card, 'normal'), card.img.normal);
  assert.equal(imageUrl(card, 'large'), 'https://cards.scryfall.io/large/front/a/b/x.jpg?1');
  assert.equal(imageUrl({ img: null }, 'large'), '');
});

await test('favorites: null means removed', () => {
  assert.equal(favoriteOf({ a: { card: null, t: 1 } }, 'a'), null);
  assert.equal(favoriteOf({ a: { card: { id: 'x' }, t: 1 } }, 'a').id, 'x');
});

// ---- favorites and rules sync between devices ----
await test('favorites and art rules sync; newest change per card wins', async () => {
  const gists = {};
  let n = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const m = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const r = (s, b) => ({ ok: s < 300, status: s, headers: { get: () => null }, json: async () => b });
    if (u.pathname === '/gists' && m === 'GET') return r(200, Object.values(gists).map((g) => ({ id: g.id, files: { 'deckbuilder-data.json': {} } })));
    if (u.pathname === '/gists' && m === 'POST') { const id = 'g' + ++n; gists[id] = { id, content: body.files['deckbuilder-data.json'].content }; return r(201, { id }); }
    const g = gists[u.pathname.split('/')[2]];
    if (m === 'GET') return r(200, { files: { 'deckbuilder-data.json': { content: g.content } } });
    g.content = body.files['deckbuilder-data.json'].content;
    return r(200, {});
  };
  let clock = 100;
  const card = (id) => ({ id, oracle_id: 'o-' + id.split('-')[0], name: id, img: {} });
  const fetchCards = async (ids) => ({ found: ids.map((x) => card(x.id)) });
  const dev = () => {
    const d = { decks: {}, art: { favs: {}, art: { rules: [], prefer: '', t: 0 } }, state: { token: 't', gistId: '', base: {}, deleted: {} } };
    d.sync = () => runSync({
      state: d.state, getDecks: () => d.decks, apply: () => {}, fetchCards, now: () => ++clock,
      getSettings: () => d.art,
      applySettings: ({ favs, art }) => { Object.assign(d.art.favs, favs); if (art) d.art.art = art; },
    });
    return d;
  };
  const pc = dev(); const phone = dev();
  pc.art.favs['o-bolt'] = { card: card('bolt-jp'), t: ++clock };
  pc.art.art = { rules: [{ id: 'x', label: 'Secret Lair', query: 's:sld', on: true }], prefer: 'oldest', t: ++clock };
  await pc.sync();
  await phone.sync();
  assert.equal(phone.art.favs['o-bolt'].card.id, 'bolt-jp');   // card details restored
  assert.equal(phone.art.art.prefer, 'oldest');
  phone.art.favs['o-bolt'] = { card: null, t: ++clock };         // un-favorite on phone
  pc.art.favs['o-opt'] = { card: card('opt-sta'), t: ++clock };   // new favorite on PC
  await phone.sync(); await pc.sync(); await phone.sync();
  for (const d of [pc, phone]) {
    assert.equal(d.art.favs['o-bolt'].card, null);
    assert.equal(d.art.favs['o-opt'].card.id, 'opt-sta');
  }
});

console.log(`\n${passed} art tests passed`);
