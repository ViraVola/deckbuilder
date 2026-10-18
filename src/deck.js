// Deck model and rules. A deck looks like:
// { id, name, format, commanders: [card, card?], main: [{card, qty}], maybe: [{card, qty}], updated }
// "commanders" holds up to two cards (partner / background / friends forever...).

export const FORMATS = [
  { id: 'commander', label: 'Commander', scry: 'commander', total: 100, singleton: true },
  { id: 'canlander', label: 'Canadian Highlander', scry: null, singleton: true },
  { id: 'duel', label: 'Duel Commander', scry: 'duel', total: 100, singleton: true },
  { id: 'legacy', label: 'Legacy', scry: 'legacy', min: 60 },
  { id: 'vintage', label: 'Vintage', scry: 'vintage', min: 60 },
  { id: 'freeform', label: 'Freeform', scry: null },
];

export const MAX_COMMANDERS = 2;
export const WUBRG = ['W', 'U', 'B', 'R', 'G'];

export const formatInfo = (id) => FORMATS.find((f) => f.id === id) || FORMATS[FORMATS.length - 1];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const newId = uid;

export function newDeck(name = 'Untitled deck', format = 'commander') {
  return { id: uid(), name, format, commanders: [], main: [], maybe: [], updated: Date.now() };
}

export const frontType = (card) => String(card.type_line || '').split(' // ')[0];
export const isBasicLand = (card) => /\bBasic\b.*\bLand\b/.test(frontType(card));
const sameCard = (a, b) => a.oracle_id === b.oracle_id || a.name === b.name;

const touch = (deck) => {
  deck.updated = Date.now();
  return deck;
};

const listFor = (deck, zone) => (zone === 'maybe' ? deck.maybe : deck.main);

export function addCard(deck, card, zone = 'main', qty = 1) {
  if (zone === 'commander') return addCommander(deck, card);
  const list = listFor(deck, zone);
  const existing = list.find((e) => sameCard(e.card, card));
  if (existing) existing.qty += qty;
  else list.push({ card, qty });
  touch(deck);
  return { ok: true };
}

export function addCommander(deck, card) {
  if (deck.commanders.some((c) => sameCard(c, card))) {
    return { ok: false, msg: `${card.name} is already a commander.` };
  }
  if (deck.commanders.length >= MAX_COMMANDERS) {
    return { ok: false, msg: 'Two commanders already. Remove one first.' };
  }
  deck.commanders.push(card);
  touch(deck);
  return { ok: true };
}

export function setQty(deck, zone, name, qty) {
  const list = listFor(deck, zone);
  const i = list.findIndex((e) => e.card.name === name);
  if (i < 0) return;
  if (qty <= 0) list.splice(i, 1);
  else list[i].qty = qty;
  touch(deck);
}

export function removeCard(deck, zone, name) {
  setQty(deck, zone, name, 0);
}

export function removeCommander(deck, name, returnToMain = true) {
  const i = deck.commanders.findIndex((c) => c.name === name);
  if (i < 0) return;
  const [card] = deck.commanders.splice(i, 1);
  if (returnToMain) addCard(deck, card, 'main', 1);
  touch(deck);
}

// Move a whole entry between main and maybeboard.
export function moveCard(deck, name, from, to) {
  const src = listFor(deck, from);
  const i = src.findIndex((e) => e.card.name === name);
  if (i < 0) return;
  const [entry] = src.splice(i, 1);
  addCard(deck, entry.card, to, entry.qty);
}

// Promote a card from main/maybeboard to a commander slot (takes one copy).
export function makeCommander(deck, name) {
  for (const zone of ['main', 'maybe']) {
    const list = listFor(deck, zone);
    const entry = list.find((e) => e.card.name === name);
    if (!entry) continue;
    const res = addCommander(deck, entry.card);
    if (res.ok) setQty(deck, zone, name, entry.qty - 1);
    return res;
  }
  return { ok: false, msg: 'Card not found in deck.' };
}

// Swap in a different printing of a card everywhere it appears.
export function swapPrinting(deck, name, newCard) {
  for (const e of [...deck.main, ...deck.maybe]) if (e.card.name === name) e.card = newCard;
  deck.commanders = deck.commanders.map((c) => (c.name === name ? newCard : c));
  touch(deck);
}

// ---- Commander pairing -------------------------------------------------

const text = (c) => c.oracle_text || '';
const hasPartner = (c) => /^Partner(?! with)/m.test(text(c));
const partnerWith = (c) => {
  const m = /^Partner with ([^(\n]+?)(?:\s*\(|$)/m.exec(text(c));
  return m ? m[1].trim() : null;
};
const hasFriends = (c) => /^Friends forever/m.test(text(c));
const chooseBackground = (c) => /^Choose a Background/m.test(text(c));
const isBackground = (c) => /\bBackground\b/.test(frontType(c));
const isDoctor = (c) => /\bTime Lord Doctor\b/.test(frontType(c));
const doctorsCompanion = (c) => /Doctor's companion/.test(text(c));

export function pairingProblem(commanders) {
  if (commanders.length < 2) return null;
  const [a, b] = commanders;
  const ok =
    (hasPartner(a) && hasPartner(b)) ||
    (partnerWith(a) && partnerWith(a) === b.name.split(' // ')[0]) ||
    (partnerWith(b) && partnerWith(b) === a.name.split(' // ')[0]) ||
    (hasFriends(a) && hasFriends(b)) ||
    (chooseBackground(a) && isBackground(b)) ||
    (chooseBackground(b) && isBackground(a)) ||
    (doctorsCompanion(a) && isDoctor(b)) ||
    (doctorsCompanion(b) && isDoctor(a));
  return ok ? null : `${a.name} and ${b.name} may not be a legal commander pair (needs Partner, Background, etc.).`;
}

// Cards that could plausibly be a commander, for the "pick your commander" prompt.
export function commanderCandidates(deck) {
  return deck.main
    .map((e) => e.card)
    .filter((c) => {
      const t = frontType(c);
      return (
        (/\bLegendary\b/.test(t) && /\bCreature\b/.test(t)) ||
        /\bBackground\b/.test(t) && /\bLegendary\b/.test(t) ||
        /can be your commander/i.test(text(c))
      );
    });
}

export function commanderIdentity(deck) {
  const set = new Set();
  for (const c of deck.commanders) for (const col of c.color_identity) set.add(col);
  return WUBRG.filter((c) => set.has(c));
}

// ---- Grouping, counts, checks -------------------------------------------

export const TYPE_ORDER = [
  'Creature',
  'Planeswalker',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Battle',
  'Land',
  'Other',
];

export function cardGroup(card) {
  const t = frontType(card);
  if (/\bLand\b/.test(t)) return 'Land';
  for (const g of ['Creature', 'Planeswalker', 'Battle', 'Artifact', 'Enchantment', 'Instant', 'Sorcery']) {
    if (new RegExp('\\b' + g + '\\b').test(t)) return g;
  }
  return 'Other';
}

export function groupByType(list) {
  const groups = new Map();
  for (const e of list) {
    const g = cardGroup(e.card);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const ordered = [];
  for (const g of TYPE_ORDER) {
    if (!groups.has(g)) continue;
    const entries = groups.get(g).sort((a, b) => a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name));
    ordered.push({ group: g, entries, count: entries.reduce((n, e) => n + e.qty, 0) });
  }
  return ordered;
}

export const countList = (list) => list.reduce((n, e) => n + e.qty, 0);

export function deckCounts(deck) {
  const main = countList(deck.main);
  return { main, commanders: deck.commanders.length, total: main + deck.commanders.length, maybe: countList(deck.maybe) };
}

// Checks are advisory: the app never blocks you from adding a card.
// Returns { general: [messages], byCard: Map(cardName -> [messages]) }.
export function issues(deck) {
  const general = [];
  const byCard = new Map();
  const flag = (name, msg) => {
    if (!byCard.has(name)) byCard.set(name, []);
    byCard.get(name).push(msg);
  };
  const fmt = formatInfo(deck.format);
  const counts = deckCounts(deck);
  const pair = pairingProblem(deck.commanders);
  if (pair) general.push(pair);

  if (fmt.total && counts.total !== fmt.total) {
    general.push(`${counts.total} of ${fmt.total} cards (including commanders).`);
  }
  if (fmt.min && counts.total < fmt.min) general.push(`${counts.total} cards; ${fmt.min} minimum.`);

  const identity = commanderIdentity(deck);
  const checkIdentity = deck.commanders.length > 0 && fmt.singleton;
  const all = [
    ...deck.main.map((e) => ({ card: e.card, qty: e.qty })),
    ...deck.commanders.map((card) => ({ card, qty: 1, cmd: true })),
  ];

  for (const e of deck.main) {
    if (fmt.singleton && e.qty > 1 && !isBasicLand(e.card) && !/any number of cards named/i.test(text(e.card))) {
      flag(e.card.name, `${e.qty} copies in a singleton format.`);
    }
  }
  for (const e of all) {
    if (checkIdentity && !e.cmd && e.card.color_identity.some((c) => !identity.includes(c))) {
      flag(e.card.name, `outside your commander's color identity.`);
    }
    if (fmt.scry) {
      const status = e.card.legalities && e.card.legalities[fmt.scry];
      if (status && status !== 'legal' && !(status === 'restricted' && e.qty <= 1)) {
        flag(e.card.name, `${status.replace('_', ' ')} in ${fmt.label}.`);
      }
    }
  }
  return { general, byCard };
}

// Flat list of readable warnings.
export function warnings(deck) {
  const { general, byCard } = issues(deck);
  const out = [...general];
  for (const [name, msgs] of byCard) for (const m of msgs) out.push(`${name}: ${m}`);
  return out;
}

// Plain-text export, importable by most sites and by this app.
export function toText(deck) {
  const line = (e) => `${e.qty} ${e.card.name}`;
  const parts = [];
  if (deck.commanders.length) parts.push('Commander\n' + deck.commanders.map((c) => `1 ${c.name}`).join('\n'));
  parts.push('Deck\n' + deck.main.slice().sort((a, b) => a.card.name.localeCompare(b.card.name)).map(line).join('\n'));
  if (deck.maybe.length) parts.push('Sideboard\n' + deck.maybe.slice().sort((a, b) => a.card.name.localeCompare(b.card.name)).map(line).join('\n'));
  return parts.join('\n\n') + '\n';
}

// Build a deck from resolved import entries.
export function deckFromResolved(name, format, resolved) {
  const deck = newDeck(name, format);
  for (const r of resolved) {
    if (r.zone === 'commander') addCommander(deck, r.card);
    else addCard(deck, r.card, r.zone, r.qty);
  }
  return deck;
}
