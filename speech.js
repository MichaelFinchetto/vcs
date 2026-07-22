/**
 * speech.js — continuous speech-to-text using the Web Speech API
 * (built into Chrome/Edge, free, low-latency, runs locally/via browser).
 *
 * Emits interim results for live feedback and final results for
 * translation + broadcast to peers.
 */

const SpeechService = (() => {
  const LANG_MAP = { en: "en-GB", uk: "uk-UA" };

  let recognition = null;
  let running = false;
  let wantRunning = false;
  let currentLang = "en"; // remembered so hard restarts can rebuild
  let onFinal = null;
  let onInterim = null;
  let onError = null;
  let restartTimer = null;
  let recentRestarts = []; // timestamps, to detect crash loops
  let stallRestarts = []; // watchdog-forced restarts, to detect a sick engine
  let degradedWarned = false; // only report engine-degraded once per start
  let watchdogTimer = null;
  let lastActivity = 0; // last time the recognizer showed signs of life
  let pendingInterim = ""; // in-progress text, flushed if the session dies

  // Voice-activity detection: measures real mic energy so the watchdog can
  // distinguish "user is silent" (never restart) from "user is speaking but
  // the recognizer is ignoring them" (restart fast).
  let vadCtx = null;
  let vadTimer = null;
  let voiceRunStart = 0; // when the current run of continuous speech began
  let lastVoice = 0; // last time the mic heard speech-level energy
  let noiseFloor = 0.01; // rolling estimate of ambient/quiet-room level
  let onLevel = null; // optional UI callback: (rms, speaking, threshold)
  let runPeak = 0; // loudest moment of the current speech run
  let recentPeaks = []; // peaks of recent speech runs, for quiet-mic detection
  let quietMicWarned = false; // only nag once per session
  const STALL_AFTER_SPEECH_MS = 3500; // speech w/o recognition events = stall
  const BACKSTOP_MS = 30000; // absolute ceiling, e.g. if speech is too quiet for VAD
  const QUIET_PEAK = 0.035; // speech peaking below this = probably too quiet

  function isSupported() {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  function startVAD(micStream) {
    stopVAD();
    if (!micStream || !micStream.getAudioTracks().length) return;
    try {
      vadCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = vadCtx.createMediaStreamSource(micStream);
      const analyser = vadCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      vadTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i] - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();

        // Adaptive threshold: speech = clearly above the room's noise floor.
        // A fixed threshold misses quiet speakers / low mic gain entirely.
        const threshold = Math.min(Math.max(noiseFloor * 3, 0.01), 0.06);
        const speaking = rms > threshold;
        if (!speaking) {
          // Learn the noise floor only from non-speech; drift slowly.
          noiseFloor = noiseFloor * 0.95 + rms * 0.05;
        }

        if (speaking) {
          if (!voiceRunStart) voiceRunStart = now;
          lastVoice = now;
          if (rms > runPeak) runPeak = rms;
        } else if (now - lastVoice > 1000) {
          // Speech run ended — check whether it was worryingly quiet.
          if (voiceRunStart && lastVoice - voiceRunStart > 1500) {
            recentPeaks.push(runPeak);
            if (recentPeaks.length > 5) recentPeaks.shift();
            const lastThree = recentPeaks.slice(-3);
            if (
              !quietMicWarned &&
              lastThree.length === 3 &&
              lastThree.every((p) => p < QUIET_PEAK)
            ) {
              quietMicWarned = true;
              if (onError) onError("quiet-mic");
            }
          }
          voiceRunStart = 0;
          runPeak = 0;
        }
        if (onLevel) onLevel(rms, speaking, threshold);
      }, 250);
    } catch (e) {
      console.warn("VAD unavailable — watchdog falls back to timers:", e);
      vadCtx = null;
    }
  }

  function stopVAD() {
    clearInterval(vadTimer);
    vadTimer = null;
    voiceRunStart = 0;
    lastVoice = 0;
    runPeak = 0;
    recentPeaks = [];
    if (vadCtx) {
      vadCtx.close().catch(() => {});
      vadCtx = null;
    }
  }

  function build(langCode) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = LANG_MAP[langCode] || "en-GB";
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
      pendingInterim = interim.trim();
      lastActivity = Date.now();
      if (onInterim) onInterim(pendingInterim);
    };

    rec.onaudiostart = () => {
      lastActivity = Date.now();
    };

    rec.onend = () => {
      running = false;
      lastActivity = Date.now();
      // Chrome discards interim text when a session ends — promote whatever
      // was in progress to a final result so words aren't silently lost.
      if (pendingInterim && wantRunning && onFinal) onFinal(pendingInterim);
      pendingInterim = "";
      if (onInterim) onInterim("");
      if (!wantRunning) return;

      // Detect a crash loop: >5 restarts within 15s means recognition is
      // repeatedly dying (usually Chrome can't reach its speech service).
      const now = Date.now();
      recentRestarts = recentRestarts.filter((t) => now - t < 15000);
      recentRestarts.push(now);
      if (recentRestarts.length > 5) {
        wantRunning = false;
        if (onError) onError("restart-loop");
        return;
      }

      // Chrome stops recognition periodically; auto-restart while enabled.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (wantRunning) safeStart();
      }, 250);
    };

    rec.onerror = (event) => {
      // "no-speech" and "aborted" are routine; onend handles the restart.
      if (event.error === "no-speech" || event.error === "aborted") return;

      console.warn("Speech recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantRunning = false;
      }
      if (onError) onError(event.error);
    };

    return rec;
  }

  function safeStart() {
    if (running || !recognition) return;
    try {
      recognition.start();
      running = true;
      lastActivity = Date.now();
    } catch (e) {
      /* start() throws if already started — ignore */
    }
  }

  // Hard restart: throw the recognizer away and build a fresh one.
  // abort() on a zombied session doesn't reliably fire onend, and even when
  // it does, restarting the *same* object can carry the bad state along —
  // so we never trust the old instance to come back to life.
  function hardRestart(reason) {
    if (!wantRunning || !recognition) return false;
    console.warn("Speech recognition hard restart:", reason);
    // Repeated watchdog restarts mean the engine itself is unwell — fresh
    // sessions keep stalling too. Tell the app so it can switch engines.
    if (reason !== "manual flush") {
      const now = Date.now();
      stallRestarts = stallRestarts.filter((t) => now - t < 120000);
      stallRestarts.push(now);
      if (stallRestarts.length >= 3 && !degradedWarned) {
        degradedWarned = true;
        if (onError) onError("engine-degraded");
      }
    }
    // Promote in-progress words to a final result so nothing is lost.
    if (pendingInterim && onFinal) onFinal(pendingInterim);
    pendingInterim = "";
    if (onInterim) onInterim("");
    // Detach handlers first so the dying session's onend can't double-start.
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onaudiostart = null;
    try {
      recognition.abort();
    } catch {
      /* ignore */
    }
    running = false;
    clearTimeout(restartTimer);
    recognition = build(currentLang);
    lastActivity = Date.now();
    voiceRunStart = 0;
    safeStart();
    return true;
  }

  // Manual flush (the 🔄 button): also clears a crash-loop pause so the
  // user can force a retry instead of waiting out the cooldown.
  function restart() {
    if (!recognition) return false;
    recentRestarts = [];
    wantRunning = true;
    return hardRestart("manual flush");
  }

  /**
   * Start continuous recognition.
   * @param {string} langCode  "en" | "uk"
   * @param {function} finalCb   called with each finalised utterance
   * @param {function} interimCb called with live in-progress text ("" to clear)
   * @param {function} errorCb   called with an error code when recognition fails
   * @param {MediaStream} [micStream] mic stream for voice-activity detection
   * @param {function} [levelCb]  called ~4x/sec with (rms, speaking, threshold)
   */
  function start(langCode, finalCb, interimCb, errorCb, micStream, levelCb) {
    if (!isSupported()) return false;
    stop();
    currentLang = langCode;
    onFinal = finalCb;
    onInterim = interimCb;
    onError = errorCb;
    onLevel = levelCb || null;
    recentRestarts = [];
    stallRestarts = [];
    degradedWarned = false;
    recognition = build(langCode);
    wantRunning = true;
    safeStart();
    startVAD(micStream);

    // Watchdog: Chrome's recognizer can go "zombie" — still nominally
    // running but producing no events and never firing onend. With VAD we
    // only restart when the mic hears sustained speech that the recognizer
    // is demonstrably ignoring — real silence never triggers a restart, so
    // there are no needless deaf windows. Without VAD (or if it broke),
    // fall back to a plain 20s inactivity timer; either way a 90s backstop
    // catches anything else.
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!wantRunning || !recognition) return;
      const now = Date.now();
      const sinceActivity = now - lastActivity;

      const speechIgnored =
        vadCtx &&
        voiceRunStart &&
        now - voiceRunStart > STALL_AFTER_SPEECH_MS &&
        sinceActivity > STALL_AFTER_SPEECH_MS;
      const timerFallback = !vadCtx && sinceActivity > 20000;
      const backstop = sinceActivity > BACKSTOP_MS;

      if (speechIgnored || timerFallback || backstop) {
        hardRestart(
          speechIgnored ? "mic active, recognizer silent" : "inactivity timer"
        );
      }
    }, 1000);
    return true;
  }

  function stop() {
    wantRunning = false;
    clearTimeout(restartTimer);
    clearInterval(watchdogTimer);
    stopVAD();
    pendingInterim = "";
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        /* ignore */
      }
    }
    running = false;
  }

  return { isSupported, start, stop, restart };
})();
