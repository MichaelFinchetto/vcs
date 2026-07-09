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
const ID_PREFIX = "mashaaaaa-7f3a-"; // namespace our room IDs on the public broker
const MAX_PEERS = 2; // besides self => 3 participants total

// ---------- State ----------
let peer = null;
let localStream = null;
let myName = "";
let myLang = "en";
let roomCode = "";
let isHost = false;
let sttEnabled = true;

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

// Remember the DeepL relay URL between visits.
$("relayInput").value = TranslateService.getRelayUrl();

async function enterRoom(code) {
  myName = $("nameInput").value.trim() || "Guest";
  TranslateService.setRelayUrl($("relayInput").value);
  isHost = code === null;
  roomCode = isHost ? generateRoomCode() : code;

  setLobbyBusy(true, "Requesting camera & microphone…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    setLobbyBusy(false, "Camera/microphone access denied.");
    return;
  }

  setLobbyBusy(true, "Connecting to signaling network…");

  // Host claims the room-coded ID; joiners get a random ID.
  peer = isHost ? new Peer(ID_PREFIX + roomCode) : new Peer();

  peer.on("open", () => {
    if (isHost) {
      showApp();
    } else {
      setLobbyBusy(true, "Joining room…");
      connectToPeer(ID_PREFIX + roomCode, true);
    }
  });

  peer.on("connection", handleIncomingConnection);
  peer.on("call", handleIncomingCall);

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      setLobbyBusy(false, "Room code collision — try creating again.");
    } else if (err.type === "peer-unavailable") {
      setLobbyBusy(false, "Room not found. Check the code.");
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
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  updateGridCount();
  addSystemMessage(`${info.name} left`);
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
    videoGrid.appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
  tile.querySelector(".name-tag").textContent = isLocal
    ? `${myName} (you)`
    : displayName(peers.get(id) || { name: "Guest", lang: "en" });
  updateGridCount();
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
  lobby.classList.add("hidden");
  app.classList.remove("hidden");
  $("roomCode").textContent = roomCode;
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
    SpeechService.stop();
    interimBar.classList.add("hidden");
  }
});

$("leaveBtn").addEventListener("click", () => {
  broadcast({ type: "bye" });
  if (peer) peer.destroy();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  SpeechService.stop();
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
  if (!SpeechService.isSupported()) {
    addSystemMessage(
      "Speech recognition unsupported in this browser — use Chrome or Edge."
    );
    $("sttBtn").classList.add("off");
    sttEnabled = false;
    return;
  }

  SpeechService.start(
    myLang,
    async (finalText) => {
      broadcast({ type: "speech", name: myName, lang: myLang, text: finalText });
      await renderMessage(voiceMessages, {
        name: myName,
        lang: myLang,
        text: finalText,
        mine: true,
      });
    },
    (interimText) => {
      if (interimText) {
        interimBar.textContent = `🎙️ ${interimText}…`;
        interimBar.classList.remove("hidden");
      } else {
        interimBar.classList.add("hidden");
      }
    },
    (errorCode) => {
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
          "⚠️ Speech recognition keeps failing and has been paused. Click 🗣️ twice to retry.",
        "language-not-supported":
          "⚠️ Speech recognition: this language isn't supported by your browser.",
      };
      addSystemMessage(
        explanations[errorCode] || `⚠️ Speech recognition error: ${errorCode}`
      );
      if (errorCode === "restart-loop" || errorCode === "not-allowed") {
        $("sttBtn").classList.add("off");
        sttEnabled = false;
      }
    }
  );
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

  // Translate messages written in a different language than mine.
  if (lang !== myLang) {
    const translatedEl = document.createElement("div");
    translatedEl.className = "translated";
    translatedEl.innerHTML = `<span class="sys">translating…</span>`;
    el.appendChild(translatedEl);
    scrollToBottom(container);

    const translated = await TranslateService.translate(text, lang, myLang);
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
