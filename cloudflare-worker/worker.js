/**
 * Cloudflare Worker — DeepL relay for MASHAAAAA.
 *
 * DeepL's API doesn't allow direct browser calls (no CORS), so this tiny
 * relay forwards translation requests and adds CORS headers. Your DeepL
 * API key stays here as a Worker secret, never exposed to the page.
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// DeepL language codes for the languages the app supports.
const SOURCE_CODES = { en: "EN", uk: "UK" };
const TARGET_CODES = { en: "EN-GB", uk: "UK" };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
