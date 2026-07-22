/**
 * deepgram.js — primary speech-to-text via Deepgram's streaming API.
 *
 * Audio path: mic -> AudioContext (16kHz) -> raw PCM -> WebSocket -> our
 * Cloudflare Worker (/dg, which adds the API key) -> Deepgram -> word-by-word
 * results back down the same socket. Live interim text works just like
 * Chrome's engine; unlike Chrome's engine, it doesn't randomly go deaf.
 *
 * Quota control: Deepgram bills per second of audio *sent*, so a VAD gate
 * only streams while someone is actually speaking (plus a short hangover so
 * Deepgram's endpointing can finalise, and a pre-buffer so the first
 * syllable of an utterance is never clipped). Silence costs nothing.
 *
 * Mirrors SpeechService's API shape.
 */

const DeepgramService = (() => {
  const WS_URL = "wss://masha-deepl-relay.mpearcey775.workers.dev/dg";
  const TARGET_RATE = 16000; // plenty for speech; a third of the bytes of 48k
  const PREBUFFER_MS = 600; // rolling pre-speech audio, flushed on voice
  const HANGOVER_MS = 1500; // keep streaming after speech so finals land
  const KEEPALIVE_MS = 5000; // stop Deepgram closing the idle socket
  const MAX_FAILS = 3; // consecutive connection failures before giving up

  let ws = null;
  let ctx = null;
  let source = null;
  let proc = null;
  let running = false;
  let wantRunning = false;
  let manualRestart = false;
  let lang = "en";
  let onFinal = null;
  let onInterim = null;
  let onError = null;
  let onLevel = null;

  // VAD state (same adaptive noise-floor approach as speech.js)
  let noiseFloor = 0.01;
  let lastVoice = 0;

  let preBuffer = []; // ArrayBuffers of PCM waiting for speech to start
  let preBufferedMs = 0;
  let finals = []; // is_final segments accumulating until speech_final
  let keepAliveTimer = null;
  let flushTimer = null; // local deadline so finals never sit in limbo
  let gateOpen = false; // whether we're currently streaming audio
  let failStreak = 0;

  // Post whatever finalised text we're holding as a completed utterance.
  function flushFinals() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!finals.length) return;
    const utterance = finals.join(" ");
    finals = [];
    if (onInterim) onInterim("");
    if (onFinal) onFinal(utterance);
  }

  function isSupported() {
    return (
      typeof WebSocket !== "undefined" &&
      !!(window.AudioContext || window.webkitAudioContext)
    );
  }

  function floatTo16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function startAudio(micStream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    // Ask for 16kHz directly — Chrome resamples internally, saving us the
    // downsampling code and Deepgram two-thirds of the bandwidth.
    try {
      ctx = new AC({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AC(); // browser refused the rate; we send ctx.sampleRate
    }
    source = ctx.createMediaStreamSource(micStream);
    proc = ctx.createScriptProcessor(2048, 1, 1);
    source.connect(proc);
    proc.connect(ctx.destination); // required for onaudioprocess to fire

    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const threshold = Math.min(Math.max(noiseFloor * 3, 0.01), 0.06);
      const speaking = rms > threshold;
      if (!speaking) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      const now = Date.now();
      if (speaking) lastVoice = now;
      if (onLevel) onLevel(rms, speaking, threshold);

      const chunk = floatTo16(input).buffer;
      const active = speaking || now - lastVoice < HANGOVER_MS;

      // Gate just closed: the mic has been quiet for the whole hangover, so
      // no more audio is coming. Deepgram can't hear that silence (we've
      // stopped sending) — tell it to finalise now instead of waiting, and
      // set a local deadline in case the response goes missing.
      if (gateOpen && !active) {
        gateOpen = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "Finalize" }));
        }
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushFinals, 1200);
      } else if (!gateOpen && active) {
        gateOpen = true;
      }

      if (active && ws && ws.readyState === WebSocket.OPEN) {
        // Flush the pre-buffer first so the utterance's opening syllable
        // (heard before VAD tripped) reaches Deepgram too.
        for (const buffered of preBuffer) ws.send(buffered);
        preBuffer = [];
        preBufferedMs = 0;
        ws.send(chunk);
      } else {
        // Silent (or socket down): keep a short rolling window, drop the rest.
        preBuffer.push(chunk);
        preBufferedMs += (input.length / ctx.sampleRate) * 1000;
        while (preBufferedMs > PREBUFFER_MS && preBuffer.length) {
          const dropped = preBuffer.shift();
          preBufferedMs -= (dropped.byteLength / 2 / ctx.sampleRate) * 1000;
        }
      }
    };
  }

  function stopAudio() {
    if (proc) {
      proc.onaudioprocess = null;
      try {
        proc.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (source) {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (ctx) {
      ctx.close().catch(() => {});
    }
    proc = null;
    source = null;
    ctx = null;
  }

  function handleMessage(e) {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "Error") {
      console.warn("Deepgram error message:", data);
      return;
    }
    if (data.type === "UtteranceEnd") {
      flushFinals();
      return;
    }
    if (data.type !== "Results") return;
    const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
    const text = ((alt && alt.transcript) || "").trim();

    if (data.is_final) {
      if (text) finals.push(text);
      // from_finalize marks the response to our gate-close Finalize nudge.
      if (data.speech_final || data.from_finalize) {
        flushFinals();
      } else if (onInterim) {
        onInterim(finals.join(" "));
      }
    } else if (text && onInterim) {
      onInterim([...finals, text].join(" "));
    }
  }

  function connect() {
    const rate = ctx ? ctx.sampleRate : TARGET_RATE;
    ws = new WebSocket(`${WS_URL}?lang=${lang}&rate=${rate}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      failStreak = 0;
      running = true;
      clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_MS);
    };
    ws.onmessage = handleMessage;
    ws.onclose = (event) => {
      running = false;
      clearInterval(keepAliveTimer);
      // Whatever was mid-sentence is finalised so words aren't lost.
      flushFinals();
      if (onInterim) onInterim("");
      if (!wantRunning) return;
      if (manualRestart) {
        manualRestart = false;
        connect();
        return;
      }
      console.warn("Deepgram socket closed:", event.code, event.reason);
      failStreak++;
      if (failStreak >= MAX_FAILS) {
        wantRunning = false;
        if (onError) onError("deepgram-failed");
        return;
      }
      setTimeout(() => {
        if (wantRunning) connect();
      }, 1000);
    };
    ws.onerror = () => {
      /* onclose always follows with the details */
    };
  }

  /**
   * Start streaming recognition.
   * @param {string} langCode  "en" | "uk"
   * @param {function} finalCb   called with each finalised utterance
   * @param {function} interimCb called with live in-progress text ("" to clear)
   * @param {function} errorCb   called with an error code when the engine fails
   * @param {MediaStream} micStream  the local mic stream
   * @param {function} [levelCb]  called ~8x/sec with (rms, speaking, threshold)
   */
  function start(langCode, finalCb, interimCb, errorCb, micStream, levelCb) {
    stop();
    if (!isSupported()) return false;
    if (!micStream || !micStream.getAudioTracks().length) return false;
    lang = langCode;
    onFinal = finalCb;
    onInterim = interimCb;
    onError = errorCb;
    onLevel = levelCb || null;
    wantRunning = true;
    failStreak = 0;
    try {
      startAudio(micStream);
    } catch (e) {
      console.warn("Deepgram: audio capture failed:", e);
      wantRunning = false;
      return false;
    }
    connect();
    return true;
  }

  // Manual flush (the 🔄 button): drop the socket and reconnect immediately.
  function restart() {
    if (!wantRunning) return false;
    finals = [];
    preBuffer = [];
    preBufferedMs = 0;
    if (ws && ws.readyState === WebSocket.OPEN) {
      manualRestart = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    } else {
      connect();
    }
    return true;
  }

  function stop() {
    wantRunning = false;
    manualRestart = false;
    clearInterval(keepAliveTimer);
    clearTimeout(flushTimer);
    flushTimer = null;
    gateOpen = false;
    stopAudio();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    ws = null;
    running = false;
    finals = [];
    preBuffer = [];
    preBufferedMs = 0;
    noiseFloor = 0.01;
    lastVoice = 0;
  }

  return { isSupported, start, stop, restart };
})();
