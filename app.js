/**
 * app.js — main application: P2P mesh (PeerJS), media, chat, transcripts.
 *
 * Topology: full mesh for up to 3 participants.
 *  - Host creates a Peer whose ID encodes the room code.
 *  - Joiners connect to the host; the host tells them about other members
 *    so everyone holds a direct data connection + media call to everyone.
 *  - Signaling uses PeerJS's free public broker (0.peerjs.com). All media
 *    and data afterwards flow directly peer-to-peer.
 */

"use strict";

// ---------- Constants ----------
const APP_VERSION = "0.19.0"; // bump on every change so stale caches are obvious
const ID_PREFIX = "mashaaaaa-7f3a-"; // namespace our room IDs on the public broker
const MAX_PEERS = 2; // besides self => 3 participants total
const SESSION_KEY = "masha-session"; // sessionStorage: survive refreshes, per-tab
// Preferred: Cloudflare TURN via our worker (1,000GB/month free).
const CF_TURN_URL = "https://masha-deepl-relay.mpearcey775.workers.dev/turn";
// Fallback: metered.ca (20GB/month free).
const METERED_TURN_URL =
  "https://mashagithub.metered.live/api/v1/turn/credentials?apiKey=1fe5f0f5dd60d32cdbf316fcf63a603c65ff";
const JOIN_TIMEOUT_MS = 20000;
const THEME_KEY = "masha-theme";
const VOLUME_KEY = "masha-volume"; // remembered slider position (1 = 100%)
const STT_ENGINE_KEY = "masha-stt-engine"; // "chrome" | "whisper"

// ---------- State ----------
let peer = null;
let localStream = null;
let myName = "";
let myLang = "en";
let roomCode = "";
let isHost = false;
let sttEnabled = true;
let sttEngine = localStorage.getItem(STT_ENGINE_KEY) === "whisper" ? "whisper" : "chrome";
let rejoining = false;
let rejoinAttempts = 0;
let joinTimeout = null;

/** peerId -> { conn, call, name, lang } */
const peers = new Map();

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const lobby = $("lobby");
const app = $("app");
const lobbyStatus = $("lobbyStatus");
const videoGrid = $("videoGrid");
const chatMessages = $("chatMessages");
const voiceMessages = $("voiceMessages");
const interimBar = $("interimBar");

// ================================================================
// Lobby
// ================================================================
document.querySelectorAll("#langToggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll("#langToggle button")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    myLang = btn.dataset.lang;
  });
});

$("createBtn").addEventListener("click", () => enterRoom(null));
$("joinBtn").addEventListener("click", () => {
  const code = $("joinInput").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    lobbyStatus.textContent = "Enter a valid room code.";
    return;
  }
  enterRoom(code);
});
$("joinInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("joinBtn").click();
});

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

$("versionBadge").textContent = `v${APP_VERSION}`;

// ---------- Colour themes ----------
// One colour pick generates the whole palette from its hue. Stored as
// "custom:#rrggbb"; saved preset names from older versions map to the
// closest colour so nobody loses their theme on upgrade.
const DEFAULT_THEME_HEX = "#4f8cff";
const LEGACY_THEMES = {
  midnight: "#4f8cff",
  ocean: "#2dd4bf",
  sunset: "#ff8a4f",
  forest: "#3ecf8e",
  light: "#4f8cff",
};

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function applyTheme(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) hex = DEFAULT_THEME_HEX;
  const { h, s, l } = hexToHsl(hex);
  // Tame extremes so any pick stays readable: backgrounds get a muted tint
  // of the hue, the accent keeps the colour's character but stays visible.
  const bgSat = Math.min(Math.max(s, 15), 35);
  const accentSat = Math.max(s, 55);
  const accentL = Math.min(Math.max(l, 48), 68);
  const set = (k, v) => document.body.style.setProperty(k, v);
  set("--bg", `hsl(${h}, ${bgSat}%, 8%)`);
  set("--bg-2", `hsl(${h}, ${Math.max(bgSat - 4, 12)}%, 12%)`);
  set("--bg-3", `hsl(${h}, ${Math.max(bgSat - 6, 10)}%, 17%)`);
  set("--border", `hsl(${h}, ${Math.max(bgSat - 8, 10)}%, 27%)`);
  set("--accent", `hsl(${h}, ${accentSat}%, ${accentL}%)`);
  set("--accent-2", `hsl(${(h + 45) % 360}, 85%, 70%)`);
  set("--accent-soft", `hsla(${h}, ${accentSat}%, ${accentL}%, 0.16)`);
  localStorage.setItem(THEME_KEY, `custom:${hex}`);
  document.querySelectorAll(".theme-wheel").forEach((input) => {
    if (input.value !== hex) input.value = hex;
  });
}

(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "";
  const hex = saved.startsWith("custom:")
    ? saved.slice(7)
    : LEGACY_THEMES[saved] || DEFAULT_THEME_HEX;
  applyTheme(hex);
})();
document.querySelectorAll(".theme-wheel").forEach((input) => {
  input.addEventListener("input", () => applyTheme(input.value));
});

// Tell the user (once per session) if DeepL fails and we fall back to the
// keyless translators — translation quality drops but nothing breaks.
TranslateService.setFallbackNotifier((reason) => {
  toast("⚠️ DeepL unavailable — using backup translator");
  addSystemMessage(
    `⚠️ DeepL translation unavailable (${reason}) — using backup translator. · ` +
      "DeepL недоступний — використовується резервний перекладач."
  );
});


// Public no-signup TURN servers (static credentials, best-effort community
// services). Used only if the metered.ca credentials fetch fails. WebRTC
// treats TURN as a last resort, so direct connections are always preferred.
const PUBLIC_TURN_SERVERS = [
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: ["turn:freestun.net:3478"],
    username: "free",
    credential: "free",
  },
];

async function fetchTurnServers(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TURN fetch ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new Error("empty TURN list");
  return list;
}

/**
 * STUN alone can't traverse strict NATs/CGNAT (common on mobile networks).
 * TURN relays, in order of preference: Cloudflare (via our worker),
 * metered.ca, then the public no-signup servers above.
 */
async function buildIceServers() {
  const servers = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
  ];
  try {
    servers.push(...(await fetchTurnServers(CF_TURN_URL)));
    return servers;
  } catch (e) {
    console.warn("Cloudflare TURN unavailable, trying metered.ca:", e);
  }
  try {
    servers.push(...(await fetchTurnServers(METERED_TURN_URL)));
    return servers;
  } catch (e) {
    console.warn("metered.ca TURN failed — using public relays:", e);
  }
  servers.push(...PUBLIC_TURN_SERVERS);
  return servers;
}

async function enterRoom(code, reuseCode) {
  myName = $("nameInput").value.trim() || "Guest";
  isHost = code === null;
  roomCode = isHost ? (reuseCode || generateRoomCode()) : code;

  if (peer && !peer.destroyed) peer.destroy();

  if (!localStream) {
    setLobbyBusy(true, "Requesting camera & microphone… · Запит камери та мікрофона…");
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      setLobbyBusy(false, "Camera/microphone access denied. · Доступ до камери/мікрофона заборонено.");
      return;
    }
  }

  setLobbyBusy(true, "Connecting… · З'єднання…");

  const peerOptions = { config: { iceServers: await buildIceServers() } };

  // Host claims the room-coded ID; joiners get a random ID.
  peer = isHost
    ? new Peer(ID_PREFIX + roomCode, peerOptions)
    : new Peer(peerOptions);

  peer.on("open", () => {
    if (isHost) {
      showApp();
    } else {
      setLobbyBusy(true, "Joining room… · Приєднання до кімнати…");
      connectToPeer(ID_PREFIX + roomCode, true);
      // If ICE can't get through (strict NAT/CGNAT), nothing errors — it
      // just hangs. Detect that and explain instead of spinning forever.
      clearTimeout(joinTimeout);
      joinTimeout = setTimeout(() => {
        if (app.classList.contains("hidden")) {
          setLobbyBusy(
            false,
            "Couldn't establish a connection (strict NAT/firewall?). Try again. · " +
              "Не вдалося встановити з'єднання. Спробуйте ще раз."
          );
        }
      }, JOIN_TIMEOUT_MS);
    }
  });

  peer.on("connection", handleIncomingConnection);
  peer.on("call", handleIncomingCall);

  peer.on("error", (err) => {
    const inApp = !app.classList.contains("hidden");
    if (err.type === "unavailable-id") {
      // After a refresh the broker can take a moment to free our old host ID.
      if (rejoining && rejoinAttempts < 5) {
        rejoinAttempts++;
        setLobbyBusy(true, `Rejoining room ${roomCode}… (${rejoinAttempts})`);
        setTimeout(() => enterRoom(null, roomCode), 1500);
        return;
      }
      setLobbyBusy(false, "Room code collision — try creating again.");
    } else if (err.type === "peer-unavailable") {
      // In-app this fires during host-reconnect attempts — the retry loop handles it.
      if (inApp) return;
      // Rejoining before the host is back — retry.
      if (rejoining && rejoinAttempts < 5) {
        rejoinAttempts++;
        setLobbyBusy(true, `Rejoining room ${roomCode}… (${rejoinAttempts})`);
        setTimeout(() => connectToPeer(ID_PREFIX + roomCode, true), 1500);
        return;
      }
      setLobbyBusy(false, "Room not found. Check the code. · Кімнату не знайдено. Перевірте код.");
    } else {
      console.error("Peer error:", err);
      if (!app.classList.contains("hidden")) {
        toast(`Connection error: ${err.type}`);
      } else {
        setLobbyBusy(false, `Connection error: ${err.type}`);
      }
    }
  });

  peer.on("disconnected", () => {
    // Reconnect to the broker (existing P2P links keep working regardless).
    if (peer && !peer.destroyed) peer.reconnect();
  });
}

function setLobbyBusy(busy, msg) {
  lobbyStatus.textContent = msg || "";
  $("createBtn").disabled = busy;
  $("joinBtn").disabled = busy;
  if (!busy && localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (!busy && peer) {
    peer.destroy();
    peer = null;
  }
}

// ================================================================
// Connections (data)
// ================================================================
function connectToPeer(remoteId, thenShowApp) {
  if (peers.has(remoteId) || remoteId === peer.id) return;

  const conn = peer.connect(remoteId, {
    reliable: true,
    metadata: { name: myName, lang: myLang },
  });

  conn.on("open", () => {
    registerPeer(remoteId, conn);
    // Caller initiates the media call.
    const call = peer.call(remoteId, localStream, {
      metadata: { name: myName, lang: myLang },
    });
    wireCall(remoteId, call);
    if (thenShowApp) showApp();
  });

  conn.on("data", (msg) => handleData(remoteId, msg));
  conn.on("close", () => removePeer(remoteId));
  conn.on("error", () => removePeer(remoteId));
}

function handleIncomingConnection(conn) {
  if (peers.size >= MAX_PEERS) {
    conn.on("open", () => {
      conn.send({ type: "room-full" });
      setTimeout(() => conn.close(), 500);
    });
    return;
  }

  conn.on("open", () => {
    // Tell the newcomer about everyone else so they can complete the mesh.
    if (isHost) {
      const others = [...peers.keys()].filter((id) => id !== conn.peer);
      if (others.length) conn.send({ type: "peers", ids: others });
    }
    registerPeer(conn.peer, conn);
  });

  conn.on("data", (msg) => handleData(conn.peer, msg));
  conn.on("close", () => removePeer(conn.peer));
  conn.on("error", () => removePeer(conn.peer));
}

function registerPeer(id, conn) {
  const meta = conn.metadata || {};
  const existing = peers.get(id) || {};
  peers.set(id, {
    ...existing,
    conn,
    name: meta.name || existing.name || "Guest",
    lang: meta.lang || existing.lang || "en",
  });
  // Announce ourselves (metadata only flows one way).
  conn.send({ type: "hello", name: myName, lang: myLang });
  addSystemMessage(`${peers.get(id).name} connected`);
}

function removePeer(id) {
  const info = peers.get(id);
  if (!info) return;
  peers.delete(id);
  if (info.call) info.call.close();
  const node = gainNodes.get(id);
  if (node) {
    try {
      node.source.disconnect();
      node.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    gainNodes.delete(id);
  }
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  updateGridCount();
  addSystemMessage(`${info.name} left`);

  // If we lost the host (e.g. they refreshed), keep trying to reconnect —
  // the host reclaims the same room ID when they come back.
  if (!isHost && id === ID_PREFIX + roomCode) {
    addSystemMessage("Host disconnected — waiting for them to return…");
    scheduleHostReconnect(0);
  }
}

function scheduleHostReconnect(attempt) {
  if (attempt >= 20) {
    addSystemMessage("Couldn't reach the host. Leave and rejoin when they're back.");
    return;
  }
  setTimeout(() => {
    if (!peer || peer.destroyed) return;
    if (peers.has(ID_PREFIX + roomCode)) return; // reconnected
    connectToPeer(ID_PREFIX + roomCode, false);
    scheduleHostReconnect(attempt + 1);
  }, 3000);
}

function broadcast(msg) {
  for (const { conn } of peers.values()) {
    if (conn && conn.open) conn.send(msg);
  }
}

// ================================================================
// Data protocol
// ================================================================
async function handleData(fromId, msg) {
  const info = peers.get(fromId);
  switch (msg.type) {
    case "hello": {
      if (info) {
        info.name = msg.name;
        info.lang = msg.lang;
        const tag = document.querySelector(`#tile-${CSS.escape(fromId)} .name-tag`);
        if (tag) tag.textContent = displayName(info);
      }
      break;
    }
    case "peers": {
      // Host told us about other members — connect to complete the mesh.
      msg.ids.forEach((id) => connectToPeer(id, false));
      break;
    }
    case "chat": {
      await renderMessage(chatMessages, {
        name: msg.name,
        lang: msg.lang,
        text: msg.text,
        mine: false,
      });
      break;
    }
    case "speech": {
      await renderMessage(voiceMessages, {
        name: msg.name,
        lang: msg.lang,
        text: msg.text,
        mine: false,
      });
      break;
    }
    case "room-full": {
      setLobbyBusy(false, "Room is full (3 participants max).");
      break;
    }
  }
}

// ================================================================
// Media
// ================================================================
function handleIncomingCall(call) {
  call.answer(localStream);
  wireCall(call.peer, call);
}

function wireCall(id, call) {
  const existing = peers.get(id) || {};
  const meta = call.metadata || {};
  peers.set(id, {
    ...existing,
    call,
    name: existing.name || meta.name || "Guest",
    lang: existing.lang || meta.lang || "en",
  });

  call.on("stream", (remoteStream) => addVideoTile(id, remoteStream, false));
  call.on("close", () => removePeer(id));
}

function addVideoTile(id, stream, isLocal) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = `tile-${id}`;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) {
      video.muted = true;
      video.classList.add("mirror");
    }
    const tag = document.createElement("div");
    tag.className = "name-tag";

    tile.appendChild(video);
    tile.appendChild(tag);
    if (!isLocal) tile.appendChild(buildVolumeControl(id));
    if (isLocal) tile.appendChild(buildMicMeter());
    videoGrid.appendChild(tile);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  if (!isLocal) wireTileAudio(id, stream, video);
  tile.querySelector(".name-tag").textContent = isLocal
    ? `${myName} (you)`
    : displayName(peers.get(id) || { name: "Guest", lang: "en" });
  updateGridCount();
}

// ---------- Per-participant volume (Web Audio gain, allows >100% boost) ----------
let audioCtx = null;
const gainNodes = new Map(); // peer id -> { source, gain }

function savedVolume() {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 2) : 1;
}

/**
 * Route a remote stream through a GainNode so its volume is adjustable
 * independently of system volume — including boosting up to 200%. The
 * video element is muted (audio flows via Web Audio instead) but must
 * stay attached to the stream: Chrome won't feed a remote stream into
 * Web Audio unless a media element is also consuming it.
 */
function wireTileAudio(id, stream, video) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();

    const old = gainNodes.get(id);
    if (old) {
      try {
        old.source.disconnect();
        old.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    }

    const source = audioCtx.createMediaStreamSource(stream);
    const gain = audioCtx.createGain();
    gain.gain.value = savedVolume();
    source.connect(gain);
    gain.connect(audioCtx.destination);
    gainNodes.set(id, { source, gain });
    video.muted = true;
  } catch (e) {
    // No Web Audio — fall back to the element's own volume (capped at 100%).
    console.warn("Web Audio unavailable — volume capped at 100%:", e);
    video.muted = false;
    video.volume = Math.min(savedVolume(), 1);
  }
}

function buildVolumeControl(id) {
  const wrap = document.createElement("div");
  wrap.className = "volume-ctrl";
  wrap.title = "Volume for this person only · Гучність лише цієї людини";

  const label = document.createElement("span");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "200";
  slider.step = "5";

  const initial = Math.round(savedVolume() * 100);
  slider.value = String(initial);
  label.textContent = `🔊 ${initial}%`;

  slider.addEventListener("input", () => {
    const pct = Number(slider.value);
    const v = pct / 100;
    label.textContent = `${pct === 0 ? "🔇" : "🔊"} ${pct}%`;
    localStorage.setItem(VOLUME_KEY, String(v));
    const node = gainNodes.get(id);
    if (node) {
      node.gain.gain.value = v;
    } else {
      const vid = document.querySelector(`#tile-${id} video`);
      if (vid) vid.volume = Math.min(v, 1);
    }
  });

  wrap.appendChild(label);
  wrap.appendChild(slider);
  return wrap;
}

// Mic level meter on the local tile — shows whether your voice is actually
// registering (green = loud enough to count as speech, grey = below the
// speech threshold). Doubles as a diagnostic for quiet-mic problems.
function buildMicMeter() {
  const wrap = document.createElement("div");
  wrap.className = "mic-meter";
  wrap.title = "Mic level — green means your voice is registering · Рівень мікрофона — зелений означає, що ваш голос чутно";
  const icon = document.createElement("span");
  icon.textContent = "🎙️";
  const bar = document.createElement("div");
  bar.className = "mic-meter-bar";
  const fill = document.createElement("div");
  fill.className = "mic-meter-fill";
  bar.appendChild(fill);
  wrap.appendChild(icon);
  wrap.appendChild(bar);
  return wrap;
}

function updateMicMeter(rms, speaking) {
  const fill = document.querySelector(".mic-meter-fill");
  if (!fill) return;
  // sqrt scaling makes quiet speech visible instead of a sliver
  const pct = Math.min(100, Math.round(Math.sqrt(rms) * 250));
  fill.style.width = `${pct}%`;
  fill.classList.toggle("speaking", speaking);
}

function displayName(info) {
  const flag = info.lang === "uk" ? "🇺🇦" : "🇬🇧";
  return `${flag} ${info.name}`;
}

function updateGridCount() {
  videoGrid.dataset.count = String(videoGrid.children.length);
}

// ================================================================
// Main app UI
// ================================================================
function showApp() {
  clearTimeout(joinTimeout);
  lobby.classList.add("hidden");
  app.classList.remove("hidden");
  $("roomCode").textContent = roomCode;
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ name: myName, lang: myLang, roomCode, isHost })
  );
  rejoining = false;
  rejoinAttempts = 0;
  addVideoTile("self", localStream, true);
  startSpeechRecognition();
  addSystemMessage(
    isHost
      ? `Room ${roomCode} created — share the code to invite others.`
      : `Joined room ${roomCode}.`
  );
}

$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    toast("Room code copied");
  } catch {
    toast(`Room code: ${roomCode}`);
  }
});

$("micBtn").addEventListener("click", () => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("micBtn").classList.toggle("off", !track.enabled);
});

$("camBtn").addEventListener("click", () => {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("camBtn").classList.toggle("off", !track.enabled);
});

$("sttBtn").addEventListener("click", () => {
  sttEnabled = !sttEnabled;
  $("sttBtn").classList.toggle("off", !sttEnabled);
  if (sttEnabled) {
    startSpeechRecognition();
  } else {
    stopAllSpeechEngines();
  }
});

function stopAllSpeechEngines() {
  SpeechService.stop();
  WhisperService.stop();
  interimBar.classList.add("hidden");
}

function updateEngineButton() {
  const btn = $("sttEngineBtn");
  btn.textContent = sttEngine === "whisper" ? "Ⓦ" : "Ⓒ";
  btn.title =
    sttEngine === "whisper"
      ? "Voice engine: Whisper (backup) — click for Chrome · Двигун: Whisper — натисніть для Chrome"
      : "Voice engine: Chrome — click for Whisper (backup) · Двигун: Chrome — натисніть для Whisper";
}

function setSttEngine(engine, why) {
  if (engine === sttEngine) return;
  sttEngine = engine;
  localStorage.setItem(STT_ENGINE_KEY, engine);
  updateEngineButton();
  const label = engine === "whisper" ? "Whisper (backup)" : "Chrome";
  addSystemMessage(
    `🔀 Voice engine → ${label}${why ? ` — ${why}` : ""} · Двигун розпізнавання → ${label}`
  );
  if (sttEnabled) {
    stopAllSpeechEngines();
    startSpeechRecognition();
  }
}

$("sttEngineBtn").addEventListener("click", () => {
  setSttEngine(sttEngine === "whisper" ? "chrome" : "whisper");
});

$("sttFlushBtn").addEventListener("click", () => {
  if (!sttEnabled) {
    toast("🗣️ is off — turn it on first · Спочатку увімкніть 🗣️");
    return;
  }
  const btn = $("sttFlushBtn");
  btn.classList.add("spinning");
  setTimeout(() => btn.classList.remove("spinning"), 600);
  // restart() reuses the live session; if recognition never started
  // (or was fully stopped), fall back to a full start.
  const restarted =
    sttEngine === "whisper" ? WhisperService.restart() : SpeechService.restart();
  if (!restarted) startSpeechRecognition();
  interimBar.classList.add("hidden");
  toast("Voice recognition restarted · Розпізнавання перезапущено");
});

$("leaveBtn").addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY); // deliberate exit — don't auto-rejoin
  broadcast({ type: "bye" });
  if (peer) peer.destroy();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  stopAllSpeechEngines();
  location.reload();
});

// Panel minimise / maximise
document.querySelectorAll(".min-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = $(btn.dataset.target);
    const minimised = panel.classList.toggle("minimised");
    btn.textContent = minimised ? "▢" : "—";
  });
});

// ================================================================
// Text chat
// ================================================================
$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  broadcast({ type: "chat", name: myName, lang: myLang, text });
  await renderMessage(chatMessages, {
    name: myName,
    lang: myLang,
    text,
    mine: true,
  });
});

// ================================================================
// Voice transcript
// ================================================================
function startSpeechRecognition() {
  updateEngineButton();

  const handleFinalText = async (finalText) => {
    broadcast({ type: "speech", name: myName, lang: myLang, text: finalText });
    await renderMessage(voiceMessages, {
      name: myName,
      lang: myLang,
      text: finalText,
      mine: true,
    });
  };

  if (sttEngine === "whisper") {
    const ok = WhisperService.start(
      myLang,
      handleFinalText,
      handleSttError,
      localStream,
      updateMicMeter
    );
    if (!ok) {
      addSystemMessage(
        "⚠️ Whisper engine couldn't start (no mic / recorder unsupported) — falling back to Chrome."
      );
      sttEngine = "chrome";
      localStorage.setItem(STT_ENGINE_KEY, "chrome");
      updateEngineButton();
      startSpeechRecognition();
    }
    return;
  }

  if (!SpeechService.isSupported()) {
    addSystemMessage(
      "Speech recognition unsupported in this browser — switching to the Whisper engine. · " +
        "Розпізнавання мови не підтримується — перемикаємось на Whisper."
    );
    setSttEngine("whisper");
    return;
  }

  SpeechService.start(
    myLang,
    handleFinalText,
    (interimText) => {
      if (interimText) {
        interimBar.textContent = `🎙️ ${interimText}…`;
        interimBar.classList.remove("hidden");
      } else {
        interimBar.classList.add("hidden");
      }
    },
    handleSttError,
    localStream, // mic stream — lets the recognizer detect ignored speech
    updateMicMeter
  );
}

function handleSttError(errorCode) {
  const explanations = {
    network:
      "⚠️ Speech recognition: network error — Chrome couldn't reach its speech service. Check your internet connection.",
    "audio-capture":
      "⚠️ Speech recognition: no usable microphone — is another app using it?",
    "not-allowed":
      "⚠️ Speech recognition: microphone permission denied. Re-enable it in the address bar and click 🗣️ to retry.",
    "service-not-allowed":
      "⚠️ Speech recognition: blocked by the browser. Are you on HTTPS or localhost?",
    "restart-loop":
      "⚠️ Speech recognition keeps failing — paused, retrying in 30 seconds…",
    "language-not-supported":
      "⚠️ Speech recognition: this language isn't supported by your browser.",
    "quiet-mic":
      "🎙️ Your voice is coming through very quietly — this can make transcription unreliable. " +
      "Try raising your microphone input volume (Mac: System Settings → Sound → Input) or sitting closer. · " +
      "Ваш голос звучить дуже тихо — це може погіршувати розпізнавання мови. " +
      "Спробуйте збільшити гучність мікрофона (Mac: Системні налаштування → Звук → Вхід) або сісти ближче.",
    "whisper-failed":
      "⚠️ Whisper transcription keeps failing — is the worker deployed with the AI binding? " +
      "Click Ⓦ to switch back to Chrome. · Whisper не працює — натисніть Ⓦ, щоб повернутися до Chrome.",
    "recorder-failed":
      "⚠️ Whisper engine: couldn't record the microphone in this browser.",
  };

  // Chrome's recognizer keeps stalling even across fresh sessions —
  // its speech service is unwell. Switch to the Whisper backup.
  if (errorCode === "engine-degraded") {
    if (sttEngine === "chrome") {
      setSttEngine(
        "whisper",
        "Chrome's recognition keeps stalling · Chrome постійно зависає"
      );
    }
    return;
  }

  addSystemMessage(
    explanations[errorCode] || `⚠️ Speech recognition error: ${errorCode}`
  );
  if (errorCode === "not-allowed") {
    $("sttBtn").classList.add("off");
    sttEnabled = false;
  }
  if (errorCode === "restart-loop") {
    // Auto-recover instead of requiring a manual toggle.
    setTimeout(() => {
      if (sttEnabled) startSpeechRecognition();
    }, 30000);
  }
}

// ================================================================
// Message rendering (with translation)
// ================================================================
async function renderMessage(container, { name, lang, text, mine }) {
  const el = document.createElement("div");
  el.className = "msg" + (mine ? " mine" : "");

  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const flag = lang === "uk" ? "🇺🇦" : "🇬🇧";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = `${flag} ${name} · ${time}`;

  const original = document.createElement("div");
  original.textContent = text;

  el.appendChild(meta);
  el.appendChild(original);
  container.appendChild(el);
  scrollToBottom(container);

  // Incoming messages in another language are translated into mine.
  // My own messages also show what the other side will read, so the
  // sender can sanity-check the translation.
  const targetLang = mine ? (lang === "en" ? "uk" : "en") : myLang;
  if (mine || lang !== myLang) {
    const translatedEl = document.createElement("div");
    translatedEl.className = "translated";
    translatedEl.innerHTML = `<span class="sys">translating…</span>`;
    el.appendChild(translatedEl);
    scrollToBottom(container);

    const translated = await TranslateService.translate(text, lang, targetLang);
    translatedEl.textContent = `↳ ${translated}`;
    scrollToBottom(container);
  }
}

function addSystemMessage(text) {
  for (const container of [chatMessages, voiceMessages]) {
    const el = document.createElement("div");
    el.className = "msg system";
    el.textContent = text;
    container.appendChild(el);
    scrollToBottom(container);
  }
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

// Clean up on tab close so peers get notified quickly.
window.addEventListener("beforeunload", () => {
  if (peer) peer.destroy();
});

// Auto-rejoin after a refresh (session survives per-tab reloads only).
(function tryRejoin() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return;
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  $("nameInput").value = s.name;
  myLang = s.lang;
  document
    .querySelectorAll("#langToggle button")
    .forEach((b) => b.classList.toggle("active", b.dataset.lang === s.lang));
  rejoining = true;
  lobbyStatus.textContent = `Rejoining room ${s.roomCode}…`;
  enterRoom(s.isHost ? null : s.roomCode, s.roomCode);
})();
