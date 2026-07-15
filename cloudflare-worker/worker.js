/**
 * Cloudflare Worker — DeepL relay + TURN credentials for MASHAAAAA.
 *
 * POST /      — translation. DeepL's API doesn't allow direct browser calls
 *               (no CORS), so this relay forwards requests and adds CORS
 *               headers. Your DeepL API key stays here as a Worker secret.
 * GET  /turn  — mints short-lived Cloudflare TURN credentials (1,000GB/month
 *               free). Requires a TURN key: dash.cloudflare.com → Realtime →
 *               TURN Server → Create. Then set two more secrets:
 *                 npx wrangler secret put TURN_KEY_ID     (the Key ID)
 *                 npx wrangler secret put TURN_API_TOKEN  (the API token)
 *
 * Setup (free, ~5 minutes). First get a DeepL API Free key:
 * https://www.deepl.com/pro-api (free plan, 500k chars/month).
 *
 * Option A — wrangler CLI (from this folder):
 *   npx wrangler login
 *   npx wrangler deploy
 *   npx wrangler secret put DEEPL_API_KEY   (paste your key when prompted)
 *
 * Option B — dashboard: https://dash.cloudflare.com → Workers & Pages →
 * Create Worker → deploy the "Hello World" starter → click "Edit code" →
 * replace the code with this file → Deploy. Then under Settings →
 * Variables and Secrets add a secret named DEEPL_API_KEY.
 *
 * Finally, paste the worker URL (https://<name>.<account>.workers.dev)
 * into the "DeepL relay URL" field on the MASHAAAAA lobby screen.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TURN_CRED_TTL_SECONDS = 6 * 60 * 60; // plenty for one call; re-minted per join

// DeepL language codes for the languages the app supports.
const SOURCE_CODES = { en: "EN", uk: "UK" };
const TARGET_CODES = { en: "EN-GB", uk: "UK" };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === "/turn") {
      return handleTurn(env);
    }

    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const { text, from, to } = body;
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 2000 ||
      !SOURCE_CODES[from] ||
      !TARGET_CODES[to]
    ) {
      return json({ error: "Bad request" }, 400);
    }

    const deeplRes = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: [text],
        source_lang: SOURCE_CODES[from],
        target_lang: TARGET_CODES[to],
      }),
    });

    if (!deeplRes.ok) {
      return json({ error: `DeepL ${deeplRes.status}` }, 502);
    }

    const data = await deeplRes.json();
    const translated = data.translations?.[0]?.text;
    if (!translated) {
      return json({ error: "Empty DeepL response" }, 502);
    }

    return json({ translated });
  },
};

/**
 * Mint short-lived TURN credentials from Cloudflare's Realtime TURN service.
 * The API token never leaves the worker — the browser only ever sees
 * disposable credentials that expire after TURN_CRED_TTL_SECONDS.
 * Responds with an array ready to drop into RTCPeerConnection iceServers.
 */
async function handleTurn(env) {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    return json({ error: "TURN not configured" }, 503);
  }

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_CRED_TTL_SECONDS }),
    }
  );

  if (!res.ok) {
    return json({ error: `TURN API ${res.status}` }, 502);
  }

  const data = await res.json();
  // Normalise: the API returns { iceServers: [...] } (or a single object on
  // the older generate endpoint) — always hand the app a flat array.
  const servers = Array.isArray(data.iceServers)
    ? data.iceServers
    : [data.iceServers];
  return json(servers);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
