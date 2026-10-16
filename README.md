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

Not built yet: printing picker per card, stats panel, goldfishing, Canadian Highlander points, sync between devices.

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

Your decks are stored in each browser separately, so use Export / Import to move a deck between phone and PC until sync exists.

## Files

- `index.html`, `styles.css` - the page
- `src/parser.js` - reads `.dec` and plain-text decklists
- `src/scryfall.js` - Scryfall search and card lookup
- `src/deck.js` - deck model, commander rules, warnings, export
- `src/store.js` - saving to the browser
- `src/app.js` - the interface
- `sw.js`, `manifest.webmanifest`, `icons/` - offline use and "install to home screen"
- `tests/core.test.mjs` - run with `node tests/core.test.mjs`
