// Saves decks and preferences in the browser (localStorage).
// Everything stays on the device; sync between devices comes later.

const DECKS = 'mtgdb.decks.v1';
const PREFS = 'mtgdb.prefs.v1';

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
