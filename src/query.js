// Turns what you type in the search box into a Scryfall query.
// Scryfall treats a bare word as "name contains". Here, bare words can also
// match rules text. Anything with search syntax (t:instant, ci<=ur, -o:flying,
// or, parentheses, ...) is passed through untouched.
//
// mode: 'both' (name or rules text, default) | 'name' | 'text'

const TOKEN = /(?:[^\s"]+|"[^"]*"?)+/g;
const RESERVED = new Set(['or', 'and']);

function bareTerm(tok) {
  // A quoted phrase, e.g. "draw a card"
  if (tok.startsWith('"')) {
    const inner = tok.replace(/^"|"$/g, '');
    return inner ? `"${inner}"` : null;
  }
  // A plain word (letters, digits, apostrophes, commas, hyphens inside)
  if (/^[\p{L}\p{N}][\p{L}\p{N}'’,.\-]*$/u.test(tok) && !RESERVED.has(tok.toLowerCase())) {
    return `"${tok}"`;
  }
  return null;
}

export function expandQuery(raw, mode = 'both') {
  const text = String(raw || '').trim();
  if (!text || mode === 'name') return text;
  const tokens = text.match(TOKEN) || [];
  return tokens
    .map((tok) => {
      const term = bareTerm(tok);
      if (!term) return tok;
      return mode === 'text' ? `o:${term}` : `(name:${term} or o:${term})`;
    })
    .join(' ');
}
