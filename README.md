# Clean Sweep — Co-op Edition

The cleaning simulator, now with live co-op: **2–4 players** clean the same
room together. Public quick-play rooms, private rooms with a 4-letter code
for friends, a live player counter, and an owner troll console.

## What's in here

- `server.js` — Node server (Express + WebSocket). Serves the game and runs
  the shared rooms. The server owns each room's dirt; bags/cash/gear stay in
  each player's own browser save, same as single player.
- `public/index.html` — the game (single player works offline too; the
  🌐 Online button opens the co-op lobby).
- `public/admin.html` — owner troll console: Mess Bomb, Slippery Floor,
  Dust Storm, Confetti Blast, Fake Restart popup, and announcements.
  Shows the live player count.

## Run it locally

```
npm install
ADMIN_KEY=pick-your-own-key npm start
```

Then open http://localhost:3100 and http://localhost:3100/admin.html

If `ADMIN_KEY` is not set, the server generates one and prints it once in
the startup log.

## Put it online (Render, same as Galaxy Clicker)

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add an environment variable `ADMIN_KEY` with your own secret key.
5. Done — the service URL is the game; `/admin.html` is your troll console.

## How co-op works

- **Quick Play** joins a public room with space (or starts one).
- **Create Private Room** gives a 4-letter code — friends type it in
  "Join with Code". Only people with the code can get in.
- The room creator is the host 👑 — after a team clean, the host picks
  "Mess It Up Again" or the next room for everyone.
- Everyone sees everyone else's cleaner live, with name tags, and the HUD
  shows "🟢 X in room • Y online".
