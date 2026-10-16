// Parses deck lists into { entries, unparsed }.
// Supports Decked Builder .dec files ("///mvid:... qty:... name:... loc:...")
// and plain-text lists ("4 Lightning Bolt", "SB: 1 Foo", "Sideboard" headers,
// Moxfield/Arena style "1 Foo (SET) 123").

const DB_LINE = /^\/\/\/mvid:(\d+)\s+qty:(\d+)\s+name:(.+?)\s+loc:(\S+)\s*$/;

const ZONE_HEADERS = {
  deck: 'main',
  main: 'main',
  mainboard: 'main',
  sideboard: 'maybe',
  sb: 'maybe',
  maybeboard: 'maybe',
  maybe: 'maybe',
  companion: 'maybe',
  commander: 'commander',
  commanders: 'commander',
};

export function parseDeckList(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const isDecked = lines.some((l) => DB_LINE.test(l.trim()));
  const entries = [];
  const unparsed = [];
  const index = new Map();

  const push = (qty, name, zone, extra = {}) => {
    const key = zone + '|' + name.toLowerCase();
    if (index.has(key)) {
      index.get(key).qty += qty;
      return;
    }
    const entry = { qty, name, zone, ...extra };
    index.set(key, entry);
    entries.push(entry);
  };

  let zone = 'main';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (isDecked) {
      // Decked Builder repeats each card as a plain line and ends with an
      // encoded cache line; only the "///mvid" lines carry what we need.
      const m = DB_LINE.exec(line);
      if (m) {
        push(Number(m[2]), m[3], m[4].toUpperCase() === 'SB' ? 'maybe' : 'main', {
          mvid: Number(m[1]),
        });
      }
      continue;
    }

    if (line.startsWith('#') || /^\/\/(?!\/)\s/.test(line) || line === '//') continue;

    const header = ZONE_HEADERS[line.replace(/[:\s]+$/, '').toLowerCase()];
    if (header) {
      zone = header;
      continue;
    }

    let rest = line;
    let z = zone;
    const sb = /^SB:\s*/i.exec(rest);
    if (sb) {
      z = 'maybe';
      rest = rest.slice(sb[0].length);
    }
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(rest);
    if (!m) {
      unparsed.push(line);
      continue;
    }
    let name = m[2].trim();
    const extra = {};
    const setMatch = /\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([^\s*]+))?(?:\s+\*[A-Za-z]+\*)?$/.exec(name);
    if (setMatch) {
      name = name.slice(0, setMatch.index).trim();
      extra.set = setMatch[1].toLowerCase();
      if (setMatch[2]) extra.cn = setMatch[2];
    }
    push(Number(m[1]), name, z, extra);
  }
  return { entries, unparsed };
}
