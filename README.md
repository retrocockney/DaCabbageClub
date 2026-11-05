# CabbageMuncher Online

Live FFA multiplayer for CabbageMuncher. The game is served by a small Node server.

## Run locally
    npm install
    npm start
Open http://localhost:3000 in two browser windows and click ONLINE FFA in both.

## Deploy on Render
1. Push this folder to a GitHub repository.
2. In Render: New > Web Service > connect the repo.
3. Build command: npm install
4. Start command: npm start
5. Plan: Free is fine for testing. Free services sleep when idle, so the first connection can take about 30 seconds.

## How it works
- server.js owns rooms, player positions, health, kills and respawn timing.
- Quick join puts you in a public room with up to 12 players.
- JOIN FRIEND CODE puts you in a private room. Share the same code with friends.
- Positions are sent 15 times a second and interpolated on other clients.
- Each client detects its own hits against the arena and reports them. The server checks range and rate, then applies damage.
- Wallet, armoury unlocks and skins stay in the browser's localStorage, as before.

## Known limits
- Hit reports are trusted from the shooter's client, so a modified client could cheat. Fine for friends, not for competitive play.
- Server does not check arena walls, so a player can move through geometry in the server's view. Clients still see correct collisions.
- Horror mode and 1v1 duel are still offline.
