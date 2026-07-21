/**
 * whisper.js — backup speech-to-text via Workers AI Whisper.
 *
 * Chrome's built-in Web Speech API streams to Google's servers and, for some
 * users, silently stops hearing for random stretches. This engine bypasses
 * it entirely: the mic is recorded locally with MediaRecorder, segmented
 * into utterances by voice-activity detection, and each utterance is sent
 * to our Cloudflare Worker's /stt endpoint for transcription.
 *
 * Mirrors SpeechService's API shape (minus interim results — Whisper
 * transcribes whole clips, so text arrives per-utterance, not per-word).
 */

const WhisperService = (() => {
  const STT_URL = "https://masha-deepl-relay.mpearcey775.workers.dev/stt";

  const SILENCE_END_MS = 900; // this much silence ends an utterance
  const MAX_UTTER_MS = 15000; // force-flush marathon sentences
  const MIN_SPEECH_MS = 350; // shorter blips are ignored (coughs, clicks)
  const IDLE_RECYCLE_MS = 20000; // discard speechless recordings periodically
  const MIN_BLOB_BYTES = 3000; // tiny blobs are headers + silence

  let running = false;
  let lang = "en";
  let stream = null; // audio-only clone of the mic stream
  let onFinal = null;
  let onError = null;
  let onLevel = null;

  let recorder = null;
  let recStart = 0;

  // VAD state (same adaptive approach as speech.js)
  let vadCtx = null;
  let vadTimer = null;
  let noiseFloor = 0.01;
  let speechStart = 0; // when speech began within the current recording
  let lastVoice = 0;
  let hadSpeech = false;

  let errorStreak = 0; // consecutive failed uploads before we report

  function isSupported() {
    return typeof MediaRecorder !== "undefined";
  }

  function pickMime() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  function startRecorder() {
    if (!running) return;
    const localChunks = [];
    let rec;
    try {
      const mime = pickMime();
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      console.warn("Whisper: MediaRecorder failed:", e);
      running = false;
      if (onError) onError("recorder-failed");
      return;
    }
    // This recording should be flushed (sent) only if it contains speech.
    hadSpeech = false;
    speechStart = 0;
    recStart = Date.now();

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) localChunks.push(e.data);
    };
    rec.onstop = () => {
      const spoke = hadSpeech;
      const blob = new Blob(localChunks, { type: rec.mimeType });
      // Chain the next recording immediately so no speech falls in a gap.
      startRecorder();
      if (spoke && blob.size >= MIN_BLOB_BYTES) transcribe(blob);
    };
    rec.start();
    recorder = rec;
  }

  function flushRecorder() {
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop(); // onstop sends the blob and restarts
      } catch {
        /* ignore */
      }
    }
  }

  async function transcribe(blob) {
    try {
      const res = await fetch(`${STT_URL}?lang=${lang}`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      errorStreak = 0;
      const text = (data.text || "").trim();
      if (text && running && onFinal) onFinal(text);
    } catch (e) {
      console.warn("Whisper transcription failed:", e);
      errorStreak++;
      // One flaky request isn't worth a warning; three in a row is.
      if (errorStreak === 3 && running && onError) onError("whisper-failed");
    }
  }

  function startVAD() {
    try {
      vadCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = vadCtx.createMediaStreamSource(stream);
      const analyser = vadCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      vadTimer = setInterval(() => {
        if (!running) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i] - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();

        const threshold = Math.min(Math.max(noiseFloor * 3, 0.01), 0.06);
        const speaking = rms > threshold;
        if (!speaking) noiseFloor = noiseFloor * 0.95 + rms * 0.05;

        if (speaking) {
          if (!speechStart) speechStart = now;
          lastVoice = now;
          if (now - speechStart >= MIN_SPEECH_MS) hadSpeech = true;
        }

        // Utterance boundary: real speech happened, then silence settled.
        if (hadSpeech && !speaking && now - lastVoice > SILENCE_END_MS) {
          flushRecorder();
        } else if (hadSpeech && now - speechStart > MAX_UTTER_MS) {
          flushRecorder();
        } else if (!hadSpeech && now - recStart > IDLE_RECYCLE_MS) {
          flushRecorder(); // discards (no speech) — bounds memory
        }

        if (onLevel) onLevel(rms, speaking, threshold);
      }, 250);
    } catch (e) {
      console.warn("Whisper: VAD unavailable — cannot segment, stopping:", e);
      stop();
      if (onError) onError("recorder-failed");
    }
  }

  /**
   * Start utterance-based transcription.
   * @param {string} langCode  "en" | "uk"
   * @param {function} finalCb  called with each transcribed utterance
   * @param {function} errorCb  called with an error code on failure
   * @param {MediaStream} micStream  the local mic stream
   * @param {function} [levelCb]  called ~4x/sec with (rms, speaking, threshold)
   */
  function start(langCode, finalCb, errorCb, micStream, levelCb) {
    stop();
    if (!isSupported()) return false;
    if (!micStream || !micStream.getAudioTracks().length) return false;
    lang = langCode;
    onFinal = finalCb;
    onError = errorCb;
    onLevel = levelCb || null;
    stream = new MediaStream(micStream.getAudioTracks());
    running = true;
    errorStreak = 0;
    startRecorder();
    startVAD();
    return running;
  }

  // Manual flush (the 🔄 button): recycle the recorder, dropping anything
  // buffered, and start listening fresh.
  function restart() {
    if (!running) return false;
    hadSpeech = false; // discard the current recording's contents
    flushRecorder();
    return true;
  }

  function stop() {
    running = false;
    clearInterval(vadTimer);
    vadTimer = null;
    if (vadCtx) {
      vadCtx.close().catch(() => {});
      vadCtx = null;
    }
    if (recorder && recorder.state === "recording") {
      recorder.onstop = null; // don't send or restart
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    recorder = null;
    stream = null;
    noiseFloor = 0.01;
    speechStart = 0;
    lastVoice = 0;
    hadSpeech = false;
  }

  return { isSupported, start, stop, restart };
})();
