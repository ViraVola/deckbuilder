// Run with: node tests/core.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseDeckList } from '../src/parser.js';
import { expandQuery } from '../src/query.js';
import { resolveEntries, slimCard } from '../src/scryfall.js';
import {
  newDeck, addCard, makeCommander, addCommander, removeCommander, pairingProblem,
  commanderIdentity, groupByType, deckCounts, warnings, toText, deckFromResolved,
} from '../src/deck.js';

let passed = 0;
const test = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log('ok  -', name); });

const dec = readFileSync(new URL('./crystal-spellslinger.dec', import.meta.url), 'utf8');

await test('parses Decked Builder file', () => {
  const { entries, unparsed } = parseDeckList(dec);
  const main = entries.filter((e) => e.zone === 'main');
  const maybe = entries.filter((e) => e.zone === 'maybe');
  assert.equal(unparsed.length, 0);
  assert.equal(main.length, 100); // Crystal is listed in the main deck; no commander marker in .dec files
  assert.equal(maybe.reduce((n, e) => n + e.qty, 0), 33);
  assert.equal(maybe.find((e) => e.name === 'Namor the Sub-Mariner').qty, 2);
  assert.equal(entries.find((e) => e.name === 'Crystal, Inhuman Princess').mvid, 1319386);
  assert.ok(entries.find((e) => e.name.includes('Tamiyo, Inquisitive Student //')));
});

await test('parses plain text with headers, SB prefix, set codes', () => {
  const { entries } = parseDeckList(
    'Commander\n1 Kenrith, the Returned King\n\nDeck\n4x Lightning Bolt (2XM) 117\n20 Mountain\n\nSideboard\n2 Pyroblast\nSB: 1 Smash to Smithereens\n'
  );
  assert.deepEqual(entries.map((e) => [e.zone, e.qty, e.name]), [
    ['commander', 1, 'Kenrith, the Returned King'],
    ['main', 4, 'Lightning Bolt'],
    ['main', 20, 'Mountain'],
    ['maybe', 2, 'Pyroblast'],
    ['maybe', 1, 'Smash to Smithereens'],
  ]);
  assert.equal(entries[1].set, '2xm');
  assert.equal(entries[1].cn, '117');
});

// Minimal fake Scryfall card builder
const fake = (name, o = {}) => ({
  id: 'id-' + name, oracle_id: 'o-' + name, name, cmc: o.cmc ?? 2, mana_cost: o.mana_cost ?? '{1}{U}',
  type_line: o.type_line ?? 'Instant', oracle_text: o.oracle_text ?? '', color_identity: o.ci ?? ['U'],
  legalities: o.legalities ?? { commander: 'legal' }, set: 'tst', collector_number: '1',
  multiverse_ids: o.mvids ?? [], image_uris: { small: 's', normal: 'n', art_crop: 'a' }, ...o.extra,
});

await test('import pipeline resolves by mvid, falls back to name, reports missing', async () => {
  const { entries } = parseDeckList(dec);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const ids = JSON.parse(opts.body).identifiers;
    calls.push(ids.length);
    const data = [];
    const not_found = [];
    for (const id of ids) {
      if (id.multiverse_id > 999999) {
        // real Scryfall rejects the whole request for 7-digit multiverse ids
        return { ok: false, status: 400, json: async () => ({ details: 'A `multiverse_id` identifier must be between 1-6 digits: ' + id.multiverse_id }) };
      }
      if (id.multiverse_id) {
        const e = entries.find((x) => x.mvid === id.multiverse_id);
        if (e.name === 'Sol Ring') { not_found.push(id); continue; } // force fallback to name
        if (e.name === 'Opt') { not_found.push(id); continue; }
        data.push(fake(e.name, { mvids: [id.multiverse_id] }));
      } else if (id.name) {
        if (id.name === 'Opt') { not_found.push(id); continue; } // truly missing
        data.push(fake(id.name));
      }
    }
    return { ok: true, status: 200, json: async () => ({ data, not_found }) };
  };
  const { resolved, missing } = await resolveEntries(entries);
  assert.deepEqual(missing, ['Opt']);
  assert.equal(resolved.length, entries.length - 1);
  assert.ok(resolved.find((r) => r.card.name === 'Sol Ring'));
  assert.deepEqual(calls, [75, 57, 2]); // 132 entries -> 2 chunks of <=75, then a name retry for the 2 misses
});

await test('slimCard handles double-faced cards', () => {
  const s = slimCard({
    id: 'x', name: 'Front // Back', cmc: 1, type_line: 'Legendary Creature — Human // Legendary Planeswalker',
    card_faces: [
      { name: 'Front', mana_cost: '{U}', oracle_text: 'a', image_uris: { normal: 'f' }, type_line: 'Legendary Creature — Human' },
      { name: 'Back', mana_cost: '', oracle_text: 'b', image_uris: { normal: 'b' } },
    ],
  });
  assert.equal(s.img.normal, 'f');
  assert.equal(s.img_back.normal, 'b');
  assert.equal(s.mana_cost, '{U}');
});

await test('two commanders; third is rejected; identity is the union', () => {
  const d = newDeck('t', 'commander');
  const a = fake('Thrasios', { type_line: 'Legendary Creature', oracle_text: 'Partner', ci: ['G', 'U'] });
  const b = fake('Tymna', { type_line: 'Legendary Creature', oracle_text: 'Partner', ci: ['W', 'B'] });
  addCard(d, a); addCard(d, b); addCard(d, fake('Sol Ring', { ci: [] }));
  assert.ok(makeCommander(d, 'Thrasios').ok);
  assert.ok(makeCommander(d, 'Tymna').ok);
  assert.equal(d.commanders.length, 2);
  assert.equal(d.main.length, 1);
  assert.equal(addCommander(d, fake('Third')).ok, false);
  assert.deepEqual(commanderIdentity(d), ['W', 'U', 'B', 'G']);
  assert.equal(pairingProblem(d.commanders), null);
  removeCommander(d, 'Tymna');
  assert.equal(d.commanders.length, 1);
  assert.equal(d.main.length, 2);
});

await test('pairing rules: partner with, background, mismatches', () => {
  const pw1 = fake('Pir, Imaginative Rascal', { type_line: 'Legendary Creature', oracle_text: 'Partner with Toothy, Imaginary Friend (When this enters...)' });
  const pw2 = fake('Toothy, Imaginary Friend', { type_line: 'Legendary Creature', oracle_text: 'Partner with Pir, Imaginative Rascal' });
  assert.equal(pairingProblem([pw1, pw2]), null);
  const bg = fake('Raised by Giants', { type_line: 'Legendary Enchantment — Background' });
  const cb = fake('Wilson', { type_line: 'Legendary Creature', oracle_text: 'Choose a Background' });
  assert.equal(pairingProblem([cb, bg]), null);
  assert.ok(pairingProblem([cb, pw1]));
  assert.ok(pairingProblem([pw1, fake('Plain', { type_line: 'Legendary Creature' })]));
});

await test('warnings and grouping work on a full import', () => {
  const { entries } = parseDeckList(dec);
  globalThis.__types = {
    'Sol Ring': 'Artifact', 'Island': 'Basic Land — Island',
  };
  const resolved = entries.map((e) => ({
    qty: e.qty, zone: e.zone,
    card: fake(e.name, {
      type_line: /Delta|Strand|Tarn|Mesa|Mire|Flats|Catacombs|Foothills|Rainforest|Heath|Tower|Island|Savannah|Taiga|Tundra|Pool|Fountain|Vents/.test(e.name) ? 'Land' : e.name === 'Opt' ? 'Instant' : 'Creature',
      cmc: 2, ci: ['U'],
    }),
  }));
  const d = deckFromResolved('Crystal Spellslinger', 'commander', resolved);
  assert.equal(deckCounts(d).main, 100);
  assert.equal(deckCounts(d).maybe, 33);
  assert.ok(makeCommander(d, 'Crystal, Inhuman Princess').ok);
  assert.equal(deckCounts(d).main, 99);
  assert.equal(deckCounts(d).total, 100); // 99 + 1 commander
  assert.ok(!warnings(d).some((w) => / of 100 cards/.test(w)));
  d.main.pop();
  assert.ok(warnings(d).some((w) => w.startsWith('99 of 100')));
  const groups = groupByType(d.main);
  assert.ok(groups.find((g) => g.group === 'Land').count >= 10);
});

await test('singleton + identity + legality warnings; export round-trips', () => {
  const d = newDeck('w', 'commander');
  const cmd = fake('Cmdr', { type_line: 'Legendary Creature', ci: ['U'] });
  addCard(d, cmd); makeCommander(d, 'Cmdr');
  addCard(d, fake('Dupe'), 'main', 2);
  addCard(d, fake('Red Thing', { ci: ['R'] }));
  addCard(d, fake('Banned Thing', { legalities: { commander: 'banned' } }));
  addCard(d, fake('Forest', { type_line: 'Basic Land — Forest', ci: ['G'] }), 'main', 5);
  const w = warnings(d);
  assert.ok(w.some((x) => x.includes('Dupe: 2 copies in a singleton format')));
  assert.ok(w.some((x) => x.includes("Red Thing: outside your commander's color identity")));
  assert.ok(w.some((x) => x.includes('Banned Thing: banned in Commander')));
  assert.ok(!w.some((x) => x.includes('Forest: 5')));
  const text = toText(d);
  const back = parseDeckList(text).entries;
  assert.equal(back.find((e) => e.zone === 'commander').name, 'Cmdr');
  assert.equal(back.find((e) => e.name === 'Dupe').qty, 2);
});

await test('plain words search name and rules text; syntax passes through', () => {
  assert.equal(expandQuery('draw card'), '(name:"draw" or o:"draw") (name:"card" or o:"card")');
  assert.equal(expandQuery('"draw a card"'), '(name:"draw a card" or o:"draw a card")');
  assert.equal(expandQuery("Gaea's Cradle"), '(name:"Gaea\'s" or o:"Gaea\'s") (name:"Cradle" or o:"Cradle")');
  assert.equal(expandQuery('t:instant o:"draw a card"'), 't:instant o:"draw a card"');
  assert.equal(expandQuery('t:instant draw'), 't:instant (name:"draw" or o:"draw")');
  assert.equal(expandQuery('-o:flying cmc<=2 or t:land'), '-o:flying cmc<=2 or t:land');
  assert.equal(expandQuery('(t:elf or t:wizard)'), '(t:elf or t:wizard)');
  assert.equal(expandQuery('storm-kiln'), '(name:"storm-kiln" or o:"storm-kiln")');
  assert.equal(expandQuery('draw card', 'name'), 'draw card');
  assert.equal(expandQuery('draw card', 'text'), 'o:"draw" o:"card"');
  assert.equal(expandQuery('   '), '');
});

console.log(`\n${passed} tests passed`);
