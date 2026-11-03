# Playtest: 4 real devices

Run this once after the first deploy, and again after any change to the online game. It checks what automated tests cannot: real phones, real networks, and whether the timing **feels** fair (PRD §7.4).

## Set-up

| Seat | Device | Browser | Language |
|---|---|---|---|
| A (host) | Desktop or laptop | Chrome or Edge | EN |
| B | Desktop or laptop | Firefox or Safari | TR |
| C | Phone | iOS Safari | EN |
| D | Phone | Android Chrome | TR |

- Use the deployed site: `https://<user>.github.io/<repository>/`.
- Everybody is on a call (voice or video) so you can talk about the experience, **never about card numbers**.
- At least one phone uses mobile data, not Wi-Fi.
- Write down the date, the site's commit (the latest **Deploy** run) and the testers.

## Checklist

Tick each box when it worked on **every** device. Write anything odd in the notes column.

### Lobby

| ✓ | Step | Notes |
|---|---|---|
| ☐ | A: **Play online 🌐** → nickname → **Create room** (Classic). The lobby shows a 6-character code | |
| ☐ | A: **Share** (or **Copy link**) and send the link to B, C and D | |
| ☐ | B, C, D open the link: **Join** is filled in and joins with one tap. All four lobbies show 4 players, all online | |
| ☐ | Somebody tries to join a 5th time (another browser): "Room is full" | |
| ☐ | A starts the game | |

### All four modes

Play at least one level of each. Between modes: finish the game or let it end, then **Rematch** (A), change the mode in the lobby, and start again.

| ✓ | Mode | What to check | Notes |
|---|---|---|---|
| ☐ | **Classic** | One pile, counting up. Everybody sees the same pile and lives | |
| ☐ | **Reverse** | One pile, counting down from 100 | |
| ☐ | **Blind** | The others see your card face down until the level ends; the reveal runs on every device | |
| ☐ | **Dual** | Two piles, ▲ and ▼. Phones can choose the pile (tap the card); desktops use ↑ / ↓ | |

### Table moments

| ✓ | Step | Notes |
|---|---|---|
| ☐ | Hands down: everybody presses ✋ (or **H** / Space); the ring fills on every device at the same time | |
| ☐ | A deliberate mistake: every device shows the same discarded cards and one heart less, then a new hands-down sync | |
| ☐ | **Star vote, accepted:** C proposes (**S** or the button); everybody sees who proposed and the votes; all say yes; each player's lowest card is discarded | |
| ☐ | **Star vote, rejected:** one player says no; the star is rejected for everybody | |
| ☐ | **Refocus** (not in Blind): everybody goes back to hands down | |
| ☐ | **Pause** and **Resume** from different players | |
| ☐ | **Next level** (Enter or the button) can be pressed by any player | |

### Connection trouble

| ✓ | Step | Notes |
|---|---|---|
| ☐ | **Forced disconnect:** D turns on airplane mode during play. Within about 6 s the others see "Waiting for <D>…" and the game pauses. D sees "Reconnecting…" | |
| ☐ | D turns airplane mode off: same seat, same hand. Somebody presses **Resume**, and the hands-down sync starts | |
| ☐ | **Reload:** B reloads during play. The table and B's hand are back within about 3 s | |
| ☐ | **Rejoin from Home:** C closes the tab, opens the site again, and taps **Rejoin your room** | |
| ☐ | **Leaving:** at the end, one player leaves during a game: the others see "Game ended — <name> left" | |

### End of game

| ✓ | Step | Notes |
|---|---|---|
| ☐ | Victory or game over shows the same result on every device | |
| ☐ | **Rematch** (host only) brings everybody back to the lobby | |
| ☐ | The journal (**Log & challenges**) lists the online game with 🌐 and the nicknames; no badge was unlocked | |
| ☐ | **Offline** play still works on a device with the network off | |

## Was the timing fair?

Each player answers on a scale of 1 (no) to 5 (yes):

| Question | A | B | C | D |
|---|---|---|---|---|
| 1. When two cards were played close together, did the order on screen match what you felt? | | | | |
| 2. Did your plays land when you pressed, without feeling delayed or "stolen" by the network? | | | | |
| 3. Did the countdowns (the hands-down ring, the vote timer) seem to run the same as for the others? | | | | |

An average below 4 on any question is a finding: describe the moment in an issue.

## Results

- **Pass:** every box is ticked, and no timing question averages below 4.
- **Findings:** file each problem as a new GitHub issue with the label `online-multiplayer`, the device, the browser, and what happened. Link the issues in the epic (#8).
- **Record** the result in the epic (#8), next to the deploy run and the smoke test (see [DEPLOY.md](./DEPLOY.md#8-the-smoke-test)).
