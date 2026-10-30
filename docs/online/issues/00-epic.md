# MIND-00 · Epic: Play The Mind online (Supabase)

> **Tracking issue. Do not implement this issue directly.** Each child issue below is one Heracles run. Run them in order, and merge each PR before starting the next.

## Goal
Let 2–4 people play The Mind together from their own browsers. They share a room code or link, the server referees fairly, and hands stay hidden. The backend is Supabase and the front-end is a static site on GitHub Pages. The offline single-player game must stay unchanged.

Full PRD: `docs/online/PRD-the-mind-online.md` (in this repository)

## Child issues (in order)
- [ ] MIND-01 · Extract the rules engine into one shared file + test/CI foundation
- [ ] MIND-02 · Make the engine online-ready (many humans, save/restore, per-player views)
- [ ] MIND-03 · Supabase backend: schema, RLS, anonymous auth, room lifecycle
- [ ] MIND-04 · Gameplay server: `room-action` Edge Function with atomic, fair state changes
- [ ] MIND-05 · Online lobby UI: create/join/share room, presence, start
- [ ] MIND-06 · Online game UI: synced table, actions, votes, reconnect, rematch
- [ ] MIND-07 · Deploy & launch: GitHub Pages + Supabase CI/CD, smoke test, docs

## Hard rules for every child issue (PRD §7.3)
| # | Rule |
|---|---|
| I1 | The server is the only referee. Card order, mistakes, lives, stars, levels, and votes are decided on the server. |
| I2 | A client never receives another player's card value that hasn't been revealed. In Blind mode this includes the pile's card values until the reveal. |
| I3 | Clients cannot write to tables directly. Every write goes through an Edge Function that uses the service-role key, which stays on the server only. |
| I4 | There is one rules engine source file, shared by offline play, the Node tests, and the Edge Function. |
| I5 | Offline single-player behavior does not change, and it works from `file://` with no network. |
| I6 | Each state change is atomic and uses optimistic concurrency (a `version` compare-and-swap). There is one clock: Postgres `clock_timestamp()`. |
| I7 | Text that users type, such as nicknames, is never inserted as HTML. Use `textContent` or the existing `esc()`. |
| I8 | The front-end holds only the Supabase URL and the publishable (anon) key. No secrets are committed. |

## Done when
All child issues are closed, the site is live, and a 4-player playtest has passed the smoke checklist in MIND-07.
