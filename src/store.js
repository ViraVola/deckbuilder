// Saves decks and preferences in the browser (localStorage).
// Sync between devices (optional) is in sync.js.

const DECKS = 'mtgdb.decks.v1';
const PREFS = 'mtgdb.prefs.v1';
const SYNC = 'mtgdb.sync.v1';
const ART = 'mtgdb.art.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

export const loadDecks = () => read(DECKS, {});
export const saveDecks = (decks) => write(DECKS, decks);
export const loadPrefs = () => ({ view: 'images', currentId: null, ...read(PREFS, {}) });
export const savePrefs = (prefs) => write(PREFS, prefs);

// Sync settings for this device: token, which gist, and what was last synced.
// Favorite printings and art rules: { favs: { oracle_id: { card, t } }, art: { rules, prefer, t } }
export const loadArtPrefs = (defaults) => {
  const v = read(ART, {});
  return { favs: v.favs || {}, art: v.art && Array.isArray(v.art.rules) ? v.art : defaults };
};
export const saveArtPrefs = (v) => write(ART, v);

export const loadSync = () => ({ token: '', gistId: '', base: {}, deleted: {}, lastSync: 0, ...read(SYNC, {}) });
export const saveSync = (s) => write(SYNC, s);

// Ask the browser not to clear our data when space runs low (some browsers,
// e.g. Safari, can otherwise delete it for sites that aren't used for a while).
export function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (_) {
    /* not supported */
  }
}
