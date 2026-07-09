/**
 * translate.js — free client-side translation with caching.
 *
 * Primary: DeepL (via your Cloudflare Worker relay — see cloudflare-worker/
 * worker.js). Fallbacks: Google Translate's public "gtx" endpoint, then
 * MyMemory. Works keyless if no relay URL is configured.
 */

const TranslateService = (() => {
  const cache = new Map(); // "from|to|text" -> translated
  const MAX_CACHE = 500;
  const RELAY_STORAGE_KEY = "masha-deepl-relay-url";

  let relayUrl = localStorage.getItem(RELAY_STORAGE_KEY) || "";
  let relayHealthy = true; // demoted for the session after repeated failures
  let relayFailures = 0;

  function setRelayUrl(url) {
    relayUrl = (url || "").trim().replace(/\/+$/, "");
    relayHealthy = true;
    relayFailures = 0;
    localStorage.setItem(RELAY_STORAGE_KEY, relayUrl);
  }

  function getRelayUrl() {
    return relayUrl;
  }

  async function viaDeepLRelay(text, from, to) {
    const res = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, from, to }),
    });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const data = await res.json();
    if (!data.translated) throw new Error("relay: empty response");
    return data.translated;
  }

  function cacheKey(text, from, to) {
    return `${from}|${to}|${text}`;
  }

  async function viaGoogle(text, from, to) {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx" +
      `&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`gtx ${res.status}`);
    const data = await res.json();
    return data[0].map((seg) => seg[0]).join("");
  }

  async function viaMyMemory(text, from, to) {
    const url =
      "https://api.mymemory.translated.net/get" +
      `?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mymemory ${res.status}`);
    const data = await res.json();
    if (data.responseStatus !== 200) throw new Error("mymemory error");
    return data.responseData.translatedText;
  }

  /**
   * Translate text between language codes ("en", "uk").
   * Returns the original text if translation fails so the UI never blocks.
   */
  async function translate(text, from, to) {
    text = text.trim();
    if (!text || from === to) return text;

    const key = cacheKey(text, from, to);
    if (cache.has(key)) return cache.get(key);

    let result = null;

    if (relayUrl && relayHealthy) {
      try {
        result = await viaDeepLRelay(text, from, to);
        relayFailures = 0;
      } catch (e) {
        console.warn("DeepL relay failed, falling back:", e);
        if (++relayFailures >= 3) relayHealthy = false;
      }
    }

    if (result === null) {
      try {
        result = await viaGoogle(text, from, to);
      } catch (e) {
        try {
          result = await viaMyMemory(text, from, to);
        } catch (e2) {
          console.warn("Translation failed:", e, e2);
          return text;
        }
      }
    }

    if (cache.size >= MAX_CACHE) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, result);
    return result;
  }

  return { translate, setRelayUrl, getRelayUrl };
})();
