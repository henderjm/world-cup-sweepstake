import { DATA_API, ENTRANTS } from "./data.js";

// Per-match banter: shared emoji reactions and one-line messages, stored server-side in
// the Worker's KV (see worker/worker.js). Needs the Worker, so it is only available when
// DATA_API is set; on the pure-static fallback the drawer simply omits the Banter tab.
//
// The drawer shows one match at a time, so this module manages a single active mount.

export const REACTIONS = ["🔥", "😂", "😱", "🧂", "🐐", "💀"];

export function banterAvailable() {
  return Boolean(DATA_API);
}

let node = null;
let matchId = null;
let data = null;
let timer = null;

// Reuse the stable per-browser id index.html already sets, so a reaction counts as one
// person across reloads. Fall back to an ephemeral id if storage is blocked.
let memoryId = null;
function visitorId() {
  try {
    let stored = window.localStorage.getItem("gs_uid");
    if (!stored) {
      // index.html sets gs_uid via Sentry; if Sentry is blocked it never runs, so
      // persist our own under the same key to keep reactions stable across reloads.
      stored = window.crypto?.randomUUID?.() ?? `u-${Math.random().toString(36).slice(2, 12)}`;
      window.localStorage.setItem("gs_uid", stored);
    }
    return stored;
  } catch {
    if (!memoryId) memoryId = `u-${Math.random().toString(36).slice(2, 12)}`;
    return memoryId;
  }
}

function displayName() {
  try {
    return window.localStorage.getItem("gs_name") || "";
  } catch {
    return "";
  }
}

function rememberName(name) {
  try {
    window.localStorage.setItem("gs_name", name);
  } catch {
    // storage blocked, name lives only for this session
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

export function mountBanter(targetNode, id) {
  // Already mounted for this exact node and match: keep the user's compose box intact.
  if (node === targetNode && matchId === id) return;
  unmountBanter();
  if (!targetNode || !banterAvailable() || id == null) return;
  node = targetNode;
  matchId = id;
  data = null;
  node.addEventListener("click", onClick);
  node.addEventListener("submit", onSubmit);
  renderSkeleton();
  refresh();
  timer = window.setInterval(refresh, 15000);
}

export function unmountBanter() {
  if (timer) window.clearInterval(timer);
  timer = null;
  if (node) {
    node.removeEventListener("click", onClick);
    node.removeEventListener("submit", onSubmit);
  }
  node = null;
  matchId = null;
  data = null;
}

async function refresh() {
  if (!node || matchId == null) return;
  const id = matchId;
  const got = await fetchBanter(id, visitorId());
  if (matchId !== id || !node) return; // drawer moved on
  if (got) {
    data = got;
    renderLive();
  } else if (!data) {
    data = { error: true };
    renderLive();
  }
}

async function fetchBanter(id, uid) {
  try {
    const response = await fetch(`${DATA_API}/banter/${id}?uid=${encodeURIComponent(uid)}`, {
      cache: "no-store",
    });
    if (!response.ok) return response.status === 503 ? { disabled: true } : null;
    return response.json();
  } catch {
    return null;
  }
}

async function send(body) {
  const id = matchId;
  try {
    const response = await fetch(`${DATA_API}/banter/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok && matchId === id) {
      data = await response.json();
      renderLive();
    }
  } catch {
    // optimistic state stands; the next refresh reconciles
  }
}

function onClick(event) {
  const button = event.target.closest("[data-react]");
  if (!button) return;
  const emoji = button.dataset.react;
  if (!data || data.disabled) data = { reactions: { counts: {}, mine: [] }, messages: [] };
  data.reactions = data.reactions || { counts: {}, mine: [] };
  const mine = new Set(data.reactions.mine);
  const counts = data.reactions.counts;
  if (mine.has(emoji)) {
    mine.delete(emoji);
    counts[emoji] = Math.max(0, (counts[emoji] ?? 1) - 1);
  } else {
    mine.add(emoji);
    counts[emoji] = (counts[emoji] ?? 0) + 1;
  }
  data.reactions.mine = [...mine];
  renderLive();
  send({ uid: visitorId(), action: "react", emoji });
}

function onSubmit(event) {
  const form = event.target.closest("[data-banter-form]");
  if (!form) return;
  event.preventDefault();
  const textInput = form.querySelector("[data-banter-text]");
  const nameInput = form.querySelector("[data-banter-name]");
  const text = (textInput.value || "").trim();
  const name = (nameInput.value || "").trim();
  if (!text) return;
  if (name) rememberName(name);
  textInput.value = "";
  if (!data || data.disabled) data = { reactions: { counts: {}, mine: [] }, messages: [] };
  data.messages = [...(data.messages ?? []), { name: name || "Someone", text, ts: Date.now() }].slice(-50);
  renderLive();
  scrollFeed();
  send({ uid: visitorId(), action: "message", name: name || displayName() || "Someone", text });
}

function renderSkeleton() {
  if (!node) return;
  node.innerHTML = `
    <div class="bn">
      <div class="bn__react" data-bn-react></div>
      <div class="bn__feed" data-bn-feed><p class="md-note">Loading banter…</p></div>
      <form class="bn__compose" data-banter-form>
        <input class="bn__name" data-banter-name list="bn-names" maxlength="24" placeholder="your name" value="${esc(displayName())}" aria-label="Your name" />
        <input class="bn__text" data-banter-text maxlength="140" placeholder="say something…" autocomplete="off" aria-label="Your banter" />
        <button class="btn bn__send" type="submit">Send</button>
        <datalist id="bn-names">${ENTRANTS.map((entrant) => `<option value="${esc(entrant.name)}"></option>`).join("")}</datalist>
      </form>
      <p class="bn__note">Reactions and banter are shared with the whole group.</p>
    </div>`;
}

function renderLive() {
  if (!node) return;
  const react = node.querySelector("[data-bn-react]");
  const feed = node.querySelector("[data-bn-feed]");
  if (!react || !feed) return;

  if (data?.disabled) {
    react.innerHTML = "";
    feed.innerHTML = `<p class="md-note">Banter isn't switched on yet.</p>`;
    return;
  }
  if (data?.error) {
    react.innerHTML = "";
    feed.innerHTML = `<p class="md-note">Couldn't reach banter. Retrying…</p>`;
    return;
  }

  const counts = data?.reactions?.counts ?? {};
  const mine = new Set(data?.reactions?.mine ?? []);
  react.innerHTML = REACTIONS.map((emoji) => {
    const count = counts[emoji] ?? 0;
    return `<button type="button" class="bn-react ${mine.has(emoji) ? "is-mine" : ""}" data-react="${emoji}" aria-pressed="${mine.has(emoji)}">${emoji}${count ? `<span>${count}</span>` : ""}</button>`;
  }).join("");

  const messages = data?.messages ?? [];
  feed.innerHTML = messages.length
    ? messages
        .map(
          (message) =>
            `<div class="bn-msg"><span class="bn-msg__name">${esc(message.name)}</span><span class="bn-msg__text">${esc(message.text)}</span></div>`,
        )
        .join("")
    : `<p class="md-note">No banter yet. Get it started.</p>`;
}

function scrollFeed() {
  const feed = node?.querySelector("[data-bn-feed]");
  if (feed) feed.scrollTop = feed.scrollHeight;
}
