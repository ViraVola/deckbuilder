// Thin Scryfall API client. Scryfall asks apps to stay under ~10 requests/sec
// and to cache data, so bulk lookups are chunked and spaced out.

const API = 'https://api.scryfall.com';
const GET_HEADERS = { Accept: 'application/json;q=0.9,*/*;q=0.8' };

const MAX_COLLECTION_MVID = 999999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function frontName(name) {
  return String(name).split(' // ')[0];
}

// Reduce a full Scryfall card object to the fields the app uses, so saved
// decks stay small.
export function slimCard(c) {
  const faces = c.card_faces || [];
  const uris = c.image_uris || (faces[0] && faces[0].image_uris) || {};
  const backUris = !c.image_uris && faces[1] && faces[1].image_uris ? faces[1].image_uris : null;
  const typeLine = c.type_line || (faces[0] && faces[0].type_line) || '';
  const oracle =
    c.oracle_text !== undefined
      ? c.oracle_text
      : faces.map((f) => f.oracle_text || '').join('\n//\n');
  const manaCost =
    c.mana_cost !== undefined && c.mana_cost !== ''
      ? c.mana_cost
      : faces.map((f) => f.mana_cost).filter(Boolean).join(' // ');
  return {
    id: c.id,
    oracle_id: c.oracle_id || (faces[0] && faces[0].oracle_id) || c.id,
    name: c.name,
    mana_cost: manaCost,
    cmc: c.cmc || 0,
    type_line: typeLine,
    oracle_text: oracle,
    colors: c.colors || (faces[0] && faces[0].colors) || [],
    color_identity: c.color_identity || [],
    keywords: c.keywords || [],
    legalities: c.legalities || {},
    set: c.set,
    set_name: c.set_name,
    cn: c.collector_number,
    rarity: c.rarity,
    layout: c.layout,
    mvids: c.multiverse_ids || [],
    img: { small: uris.small, normal: uris.normal, art: uris.art_crop },
    img_back: backUris ? { small: backUris.small, normal: backUris.normal, art: backUris.art_crop } : null,
  };
}

async function readError(res) {
  let details = '';
  try {
    const body = await res.json();
    details = body.details || '';
  } catch (_) {
    /* ignore */
  }
  return new Error(`Scryfall error ${res.status}${details ? ': ' + details : ''}`);
}

// Search with Scryfall syntax. Returns { cards, total, hasMore, nextUrl, warnings }.
export async function search(query, { unique = 'cards', order = 'name', nextUrl = null } = {}) {
  const url =
    nextUrl ||
    `${API}/cards/search?q=${encodeURIComponent(query)}&unique=${unique}&order=${order}`;
  const res = await fetch(url, { headers: GET_HEADERS });
  if (res.status === 404) return { cards: [], total: 0, hasMore: false, nextUrl: null, warnings: [] };
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  return {
    cards: (body.data || []).map(slimCard),
    total: body.total_cards || 0,
    hasMore: !!body.has_more,
    nextUrl: body.next_page || null,
    warnings: body.warnings || [],
  };
}

// Look up many cards at once (max 75 per request). Identifiers are objects
// such as { multiverse_id }, { name } or { set, collector_number }.
export async function fetchCollection(identifiers, onProgress) {
  const found = [];
  const notFound = [];
  const size = 75;
  for (let i = 0; i < identifiers.length; i += size) {
    const chunk = identifiers.slice(i, i + size);
    const res = await fetch(`${API}/cards/collection`, {
      method: 'POST',
      headers: { ...GET_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: chunk }),
    });
    if (!res.ok) throw await readError(res);
    const body = await res.json();
    found.push(...(body.data || []).map(slimCard));
    notFound.push(...(body.not_found || []));
    if (onProgress) onProgress(Math.min(i + size, identifiers.length), identifiers.length);
    if (i + size < identifiers.length) await sleep(120);
  }
  return { found, notFound };
}

// Turn parsed entries into resolved deck entries { card, qty, zone }.
// Prefers the exact printing (multiverse id, or set + number), falls back to
// a name lookup. Returns { resolved, missing }.
export async function resolveEntries(entries, onProgress) {
  // Scryfall's /cards/collection rejects multiverse ids longer than 6 digits
  // (newer cards have 7-digit ones), so those fall back to a name lookup.
  const first = entries.map((e) => {
    if (e.mvid && e.mvid <= MAX_COLLECTION_MVID) return { multiverse_id: e.mvid };
    if (e.set && e.cn) return { set: e.set, collector_number: e.cn };
    return { name: e.name };
  });
  const r1 = await fetchCollection(first, onProgress);

  const byMvid = new Map();
  const byName = new Map();
  const bySetCn = new Map();
  for (const c of r1.found) {
    for (const m of c.mvids) byMvid.set(m, c);
    byName.set(c.name.toLowerCase(), c);
    byName.set(frontName(c.name).toLowerCase(), c);
    bySetCn.set(`${c.set}|${c.cn}`, c);
  }

  const lookup = (e) =>
    (e.mvid && byMvid.get(e.mvid)) ||
    (e.set && e.cn && bySetCn.get(`${e.set}|${e.cn}`)) ||
    byName.get(e.name.toLowerCase()) ||
    byName.get(frontName(e.name).toLowerCase());

  // Second pass by plain name for anything the exact lookup missed.
  const retry = entries.filter((e) => !lookup(e));
  if (retry.length) {
    const r2 = await fetchCollection(retry.map((e) => ({ name: e.name })));
    for (const c of r2.found) {
      byName.set(c.name.toLowerCase(), c);
      byName.set(frontName(c.name).toLowerCase(), c);
    }
  }

  const resolved = [];
  const missing = [];
  for (const e of entries) {
    const card = lookup(e);
    if (card) resolved.push({ card, qty: e.qty, zone: e.zone });
    else missing.push(e.name);
  }
  return { resolved, missing };
}
