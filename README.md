# The Mind

A browser version of the cooperative card game *The Mind*. You play with 1–3 bot teammates.

## Run

Open `index.html` in a browser. You don't need to build or install anything.

## Rules

- 2 / 3 / 4 players play 12 / 10 / 8 levels. You start with lives equal to the number of players and 1 throwing star.
- In level *n*, every player gets *n* cards from 1–100. There are no turns: play your lowest card when you feel it is next.
- If a card is played while someone still holds a lower card, all those lower cards are discarded and the team loses 1 life.
- Throwing star: every player discards their lowest card.
- You get a star after levels 2, 5 and 8, and a life after levels 3, 6 and 9 (max 5 lives, 3 stars).

**Controls:** `Space` or click your lowest card to play it, `S` to propose a star, `Enter` to start the next level.

## Bots

Each bot waits about `500ms + gap × pace` (±15% jitter) before playing. `gap` is its lowest card minus the top card of the pile. Bots plan their timing again after every play, and they always agree to a proposed star.

## Files

| File | Purpose |
|------|---------|
| `game.js` | Game rules with no UI code (works in the browser and in Node) |
| `app.js` | UI, bot timing, controls |
| `index.html`, `style.css` | Page layout and styling |
| `game.test.js` | Unit tests: `node --test` |
