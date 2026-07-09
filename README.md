P2P

A serverless, peer-to-peer video chat for 2–3 people with:

- **Low-latency video + audio** — direct WebRTC connections between browsers (full mesh).
- **Text chat** — typed messages, automatically translated for readers who speak the other language.
- **Voice transcript** — what each person *says* is transcribed live and translated into text in a separate panel (no synthesized voice).
- **Minimisable panels** — both the text chat and voice transcript can be collapsed/expanded independently.

## Why no server is needed

| Concern | Solution | Cost |
|---|---|---|
| Signaling (finding each other) | [PeerJS](https://peerjs.com) free public broker (`0.peerjs.com`) — only used for the initial handshake | Free |
| Video / audio / chat data | Direct P2P WebRTC (never touches a server) | Free |
| Speech-to-text | Web Speech API, built into Chrome/Edge (`en-US`, `uk-UA`) | Free |
| Translation | DeepL API Free via a Cloudflare Worker relay (optional, best quality), falling back to Google's public `gtx` endpoint, then MyMemory | Free |
| Hosting the page itself | Run locally, or any free static host (GitHub Pages, Netlify) | Free |

## Running it

The page must be served over `http://localhost` or `https://` (browser requirement for camera access — opening `index.html` directly via `file://` will not work).

```powershell
# From this folder — pick whichever you have installed:
python -m http.server 8080
# or
npx serve -p 8080
```

Then open `http://localhost:8080` in **Chrome or Edge** (required for speech recognition).

To chat with someone remote, host the folder on a free static host (e.g. GitHub Pages) so both sides can open the same URL over HTTPS.

## Using it

1. Enter your name and pick the language you speak (🇬🇧 English / 🇺🇦 Українська).
2. One person clicks **Create room** and shares the 5-character room code.
3. Others enter the code and click **Join** (max 3 participants).
4. Talk normally — your speech appears in the **Voice transcript** panel and is translated for peers who speak the other language. Typed messages behave the same in **Text chat**.

### Controls

- 🎙️ mute/unmute microphone
- 📷 camera on/off
- 🗣️ toggle speech recognition
- 📞 leave the call
- **—** / **▢** on each panel header minimises/maximises it

## Better translations with DeepL (recommended)

The default keyless translator is weak with slang and informal speech. DeepL is much better and free for 500k characters/month, but its API blocks direct browser calls, so a tiny free Cloudflare Worker relays requests (and keeps your API key secret):

1. Get a **DeepL API Free** key: https://www.deepl.com/pro-api

2. Deploy the worker — **Option A, wrangler CLI** (needs Node.js; run from `cloudflare-worker/`):

   ```powershell
   npx wrangler login          # opens browser, sign in / create free account
   npx wrangler deploy         # prints your worker URL
   npx wrangler secret put DEEPL_API_KEY   # paste your DeepL key when prompted
   ```

   **Option B, dashboard**: at https://dash.cloudflare.com → **Workers & Pages** → **Create Worker**, deploy the "Hello World" starter, then click **Edit code**, replace the code with `cloudflare-worker/worker.js`, and **Deploy**. Add a secret named `DEEPL_API_KEY` under **Settings → Variables and Secrets**.

3. Paste the worker URL (`https://<name>.<account>.workers.dev`) into the **DeepL relay URL** field on the lobby screen. It's remembered between visits.

Each participant translates incoming messages locally, so each person can set their own relay URL (or share one — the free quota is generous).

## Notes & limits

- Speech recognition: Chrome/Edge only (Web Speech API). Firefox/Safari users still get video, chat, and can *read* others' transcripts.
- Chrome's speech recognition service restarts periodically; the app auto-restarts it seamlessly.
- The free `gtx` translate endpoint is unofficial — fine for personal use; MyMemory is used as a fallback if it fails.
- If both peers are behind strict symmetric NATs, P2P may fail (no TURN server is configured, to stay serverless). This is rare on home networks.
