// Which printing (artwork) to show for a card.
// Order: your favorite printing for that card, then your art rules from the
// top down, then Scryfall's own preference (oldest, newest, ...), then
// Scryfall's default printing.

export const PREFER_OPTIONS = [
  ['', "Scryfall's default"],
  ['oldest', 'Oldest printing'],
  ['newest', 'Newest printing'],
  ['promo', 'Promo versions'],
  ['atypical', 'Unusual frames (showcase, borderless...)'],
  ['notub', 'Not Universes Beyond'],
  ['ub', 'Universes Beyond'],
];

const isPromo = (c) => c.promo || (c.promo_types || []).length > 0;

// Extra checks on top of a rule's Scryfall filter, for things Scryfall can't
// express exactly. `base` is the card's regular (default) printing.
export const TESTS = {
  jpArchive: (c) => c.set === 'sta' && parseInt(c.cn, 10) >= 64,
  jpPromo: (c, base) =>
    c.lang === 'ja' &&
    isPromo(c) &&
    ((c.promo_types || []).includes('jpwalker') || !base || !c.illustration_id || c.illustration_id !== base.illustration_id),
  fullOrExtendedPromo: (c) => isPromo(c) && (c.full_art || (c.frame_effects || []).includes('extendedart')),
};

export const DEFAULT_RULES = [
  { id: 'jp-archive', label: 'Japanese Mystical Archive', query: 's:sta', test: 'jpArchive', on: true },
  { id: 'jp-promo', label: 'Japan-exclusive promos (Japanese promos with different art)', query: 'lang:ja is:promo', test: 'jpPromo', on: true },
  { id: 'full-ext-promo', label: 'Full-art and extended-art promos', query: 'is:promo', test: 'fullOrExtendedPromo', on: true },
];

export const defaultArt = () => ({ rules: DEFAULT_RULES.map((r) => ({ ...r })), prefer: '', t: 0 });

export const ruleMatches = (rule, card, base) => {
  const t = rule.test && TESTS[rule.test];
  return t ? !!t(card, base) : true;
};

// Among several matching printings: English first, then the newest.
export function bestOf(cands) {
  return [...cands].sort(
    (a, b) => (a.lang === 'en' ? 0 : 1) - (b.lang === 'en' ? 0 : 1) || String(b.released).localeCompare(String(a.released))
  )[0];
}

// baseCards: search results (Scryfall's default printings)
// found: Map ruleId -> Map oracle_id -> [printings returned by that rule's search]
// Returns Map oracle_id -> { card, rule } for cards a rule picked.
export function choosePrintings(baseCards, found, rules) {
  const out = new Map();
  for (const base of baseCards) {
    for (const rule of rules) {
      if (!rule.on) continue;
      const list = ((found.get(rule.id) || new Map()).get(base.oracle_id) || []).filter((c) => ruleMatches(rule, c, base));
      if (list.length) {
        out.set(base.oracle_id, { card: bestOf(list), rule: rule.label });
        break;
      }
    }
  }
  return out;
}

// Favorites: { oracle_id: { card: slimCard | null, t } }  (null = un-favorited)
export const favoriteOf = (favs, oracleId) => (favs[oracleId] && favs[oracleId].card) || null;

// Text that will match a printing that a rule picked, for the search to
// fetch: "(your search) (rule filter)".
export function ruleQuery(userQuery, rule) {
  const q = String(userQuery || '').replace(/\bprefer:\S+/g, '').trim();
  return q ? `(${q}) (${rule.query})` : rule.query;
}

// Image URL helper that also works for cards saved before larger sizes were
// stored: Scryfall's URLs differ only in the size folder.
export function imageUrl(card, size = 'normal', back = false) {
  const img = back ? card.img_back : card.img;
  if (!img) return '';
  if (img[size]) return img[size];
  const any = img.normal || img.small || img.large || '';
  return any.replace(/\/(small|normal|large)\//, `/${size}/`);
}
