/**
 * speech.js — continuous speech-to-text using the Web Speech API
 * (built into Chrome/Edge, free, low-latency, runs locally/via browser).
 *
 * Emits interim results for live feedback and final results for
 * translation + broadcast to peers.
 */

const SpeechService = (() => {
  const LANG_MAP = { en: "en-US", uk: "uk-UA" };

  let recognition = null;
  let running = false;
  let wantRunning = false;
  let onFinal = null;
  let onInterim = null;
  let restartTimer = null;

  function isSupported() {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  function build(langCode) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = LANG_MAP[langCode] || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          if (onFinal) onFinal(text);
        } else {
          interim += text + " ";
        }
      }
      if (onInterim) onInterim(interim.trim());
    };

    rec.onend = () => {
      running = false;
      if (onInterim) onInterim("");
      // Chrome stops recognition periodically; auto-restart while enabled.
      if (wantRunning) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (wantRunning) safeStart();
        }, 250);
      }
    };

    rec.onerror = (event) => {
      // "no-speech" and "aborted" are routine; onend handles the restart.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantRunning = false;
        console.warn("Speech recognition permission denied.");
      }
    };

    return rec;
  }

  function safeStart() {
    if (running || !recognition) return;
    try {
      recognition.start();
      running = true;
    } catch (e) {
      /* start() throws if already started — ignore */
    }
  }

  /**
   * Start continuous recognition.
   * @param {string} langCode  "en" | "uk"
   * @param {function} finalCb   called with each finalised utterance
   * @param {function} interimCb called with live in-progress text ("" to clear)
   */
  function start(langCode, finalCb, interimCb) {
    if (!isSupported()) return false;
    stop();
    onFinal = finalCb;
    onInterim = interimCb;
    recognition = build(langCode);
    wantRunning = true;
    safeStart();
    return true;
  }

  function stop() {
    wantRunning = false;
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        /* ignore */
      }
    }
    running = false;
  }

  return { isSupported, start, stop };
})();
