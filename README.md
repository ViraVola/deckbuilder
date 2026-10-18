# Deckbuilder

A personal MTG deckbuilder that runs in the browser on your PC and installs to your phone's home screen. Card data comes from Scryfall. Decks are saved on the device you use.

## What works so far

- Import Decked Builder `.dec` files (keeps the exact printing) and plain-text lists
- Deck view grouped by type, with a separate Commander zone that holds **two** commanders (Partner, Background, Friends forever, Doctor's companion)
- Pick-your-commander prompt after an import (a `.dec` file doesn't say which card is the commander)
- Scryfall search with its full syntax, plus filters: color identity, type, mana value, format legality, rarity, set, every-unique-art / every-printing, sort, and "only my commander's colors"
- Add to deck, maybeboard, or commander; quantity, move, remove
- Card art or text list view, card detail pop-up
- Advisory warnings (never blocking): deck size, singleton duplicates, outside commander colors, banned/not legal, illegal commander pairs
- Plain-text export, multiple decks, works offline once opened (searching needs internet)
- Autosave: every change is saved on the device straight away
- Optional sync between devices through a private gist in your own GitHub account (the Sync button)
- Sharper card images (Scryfall's "normal" size in lists, "large" in the card pop-up)
- Printing picker: "Show all printings" in any card's pop-up; use a printing in the deck or make it your favorite
- Art preferences (Filters > Art preferences): favorite printings first, then your ordered art rules, then a fallback such as oldest/newest. Favorites and rules sync too

Not built yet: stats panel, goldfishing, Canadian Highlander points.

## Try it on your computer

Browsers block some features on plain files, so serve the folder instead of double-clicking `index.html`:

    python3 -m http.server 8000

then open http://localhost:8000 (needs internet for card data).

## Put it on the web (GitHub Pages) so your phone can use it

1. On github.com, create a new repository (any name, e.g. `deckbuilder`). Public is simplest for free Pages hosting.
2. Upload everything in this folder to it (the "Add file > Upload files" button works).
3. In the repository: Settings > Pages > "Deploy from a branch" > branch `main`, folder `/ (root)` > Save.
4. After a minute, the page shows your address (like `https://YOURNAME.github.io/deckbuilder/`).
5. Open that address on your phone, then use the browser's "Add to Home Screen" (Safari: Share > Add to Home Screen; Chrome: menu > Install app).

## Sync between phone and PC

Click **Sync** in the top bar and follow the three steps. It makes a GitHub token that can only touch your gists, and the app keeps your decks in one private gist called `deckbuilder-data.json`. Do it once on each device. Edits are sent a few seconds after you make them, and other devices pick them up when the app is opened or brought back to the front. If the same deck was changed on two devices before syncing, both versions are kept (one is named "(copy from ...)").

## Files

- `index.html`, `styles.css` - the page
- `src/parser.js` - reads `.dec` and plain-text decklists
- `src/scryfall.js` - Scryfall search and card lookup
- `src/deck.js` - deck model, commander rules, warnings, export
- `src/store.js` - saving to the browser
- `src/sync.js` - sync through a GitHub gist
- `src/query.js` - turns plain words into a name-or-rules-text search
- `src/art.js` - favorite printings and art rules
- `src/app.js` - the interface
- `sw.js`, `manifest.webmanifest`, `icons/` - offline use and "install to home screen"
- `tests/` - run with `node tests/core.test.mjs`, `node tests/sync.test.mjs` and `node tests/art.test.mjs`
