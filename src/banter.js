import { DATA_API } from "./data.js";
import { authHeaders, isSignedIn, onAccountChange } from "./account.js";
import { track } from "./telemetry.js";

// Per-match banter: shared emoji reactions and one-line messages, stored in the
// Worker's D1 next to accounts. Reading is open to everyone; posting requires a
// signed-in account, so names come from Google identity and cannot be spoofed.
// D1 is strongly consistent: the state a POST returns always includes your own
// write, so the optimistic UI reconciles against it without the old KV-era
// flicker (reactions bouncing off, messages vanishing and doubling).
//
// The drawer shows one match at a time, so this module manages a single active mount.

export const REACTIONS = ["🔥", "😂", "😱", "🧂", "🐐", "💀"];

// Spoken names for the reaction buttons, which are otherwise named only by
// the emoji itself.
const REACTION_NAMES = { "🔥": "Fire", "😂": "Laughing", "😱": "Shocked", "🧂": "Salty", "🐐": "GOAT", "💀": "Dead" };

export function banterAvailable() {
  return Boolean(DATA_API);
}

let node = null;
let matchId = null;
let data = null;
let timer = null;
let unsubscribeAccount = null;
let inflight = 0; // posts in the air; refreshes are dropped while > 0
let notice = ""; // why the last post or action was refused, shown once

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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
  unsubscribeAccount = onAccountChange(() => {
    // Signing in or out swaps the compose box for the sign-in prompt (and back).
    renderSkeleton();
    renderLive();
    refresh();
  });
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
  unsubscribeAccount?.();
  unsubscribeAccount = null;
  node = null;
  matchId = null;
  data = null;
  inflight = 0;
  notice = "";
}

async function refresh() {
  if (!node || matchId == null) return;
  const id = matchId;
  const got = await fetchBanter(id);
  if (matchId !== id || !node) return; // drawer moved on
  if (inflight > 0) return; // a post is mid-air; its response supersedes this read
  if (got) {
    data = got;
    renderLive();
  } else if (!data) {
    data = { error: true };
    renderLive();
  }
}

async function fetchBanter(id) {
  try {
    const response = await fetch(`${DATA_API}/banter/${id}`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (!response.ok) return response.status === 503 ? { disabled: true } : null;
    return response.json();
  } catch {
    return null;
  }
}

async function send(body) {
  const id = matchId;
  inflight += 1;
  try {
    const response = await fetch(`${DATA_API}/banter/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (matchId !== id) return;
    if (response.ok) {
      // Authoritative: D1 reads include this very write, so replacing the
      // optimistic state never rolls the UI backwards.
      data = await response.json();
      renderLive();
    } else if (response.status === 401) {
      renderSkeleton();
      renderLive();
    } else {
      // A refusal (rate limit, moderator-only action) says why; the optimistic
      // message is dropped and the next refresh restores the true list.
      const reason = await response.json().catch(() => ({}));
      notice = reason.error || "That didn't go through. Try again in a moment.";
      if (data?.messages) data.messages = data.messages.filter((message) => !message.pending);
      renderLive();
    }
  } catch {
    // optimistic state stands; the next refresh reconciles
  } finally {
    inflight = Math.max(0, inflight - 1);
  }
}

function onClick(event) {
  const action = event.target.closest("[data-talk-action]");
  if (action && isSignedIn()) {
    const messageId = Number(action.dataset.messageId);
    if (action.dataset.talkAction === "report") {
      const message = data?.messages?.find((entry) => entry.id === messageId);
      if (message) message.reported = true;
      renderLive();
    }
    track("banter_moderation_action", { match_id: matchId, action: action.dataset.talkAction });
    send({ action: action.dataset.talkAction, messageId });
    return;
  }
  const button = event.target.closest("[data-react]");
  if (!button || !isSignedIn()) return;
  const emoji = button.dataset.react;
  if (!data || data.disabled || data.error) data = { reactions: { counts: {}, mine: [] }, messages: [] };
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
  track("banter_reaction_sent", { match_id: matchId, emoji });
  send({ action: "react", emoji });
}

function onSubmit(event) {
  const form = event.target.closest("[data-banter-form]");
  if (!form) return;
  event.preventDefault();
  if (!isSignedIn()) return;
  const textInput = form.querySelector("[data-banter-text]");
  const text = (textInput.value || "").trim();
  if (!text) return;
  textInput.value = "";
  notice = "";
  if (!data || data.disabled || data.error) data = { reactions: { counts: {}, mine: [] }, messages: [] };
  data.messages = [...(data.messages ?? []), { name: "You", text, pending: true }].slice(-50);
  renderLive();
  scrollFeed();
  track("banter_message_sent", { match_id: matchId });
  send({ action: "message", text });
}

function renderSkeleton() {
  if (!node) return;
  const compose = isSignedIn()
    ? `<form class="bn__compose" data-banter-form>
        <input class="bn__text" data-banter-text maxlength="140" placeholder="Say something" autocomplete="off" aria-label="Your banter" />
        <button class="btn bn__send" type="submit">Send</button>
      </form>`
    : `<p class="bn__note bn__note--signin"><button class="seg" type="button" data-section-nav="you" data-md-close>Sign in to post</button></p>`;
  node.innerHTML = `
    <div class="bn">
      <div class="bn__react" data-bn-react></div>
      <div class="bn__feed" data-bn-feed></div>
      ${compose}
    </div>`;
}

function renderLive() {
  if (!node) return;
  const react = node.querySelector("[data-bn-react]");
  const feed = node.querySelector("[data-bn-feed]");
  if (!react || !feed) return;

  if (data?.disabled) {
    react.innerHTML = "";
    feed.innerHTML = "";
    return;
  }
  if (data?.error) {
    react.innerHTML = "";
    feed.innerHTML = `<p class="md-note">Comments unavailable</p>`;
    return;
  }

  const signedIn = isSignedIn();
  const counts = data?.reactions?.counts ?? {};
  const mine = new Set(data?.reactions?.mine ?? []);
  react.innerHTML = REACTIONS.map((emoji) => {
    const count = counts[emoji] ?? 0;
    return `<button type="button" class="bn-react ${mine.has(emoji) ? "is-mine" : ""}" data-react="${emoji}" aria-label="${REACTION_NAMES[emoji] ?? emoji}${count ? `, ${count}` : ""}" aria-pressed="${mine.has(emoji)}" ${signedIn ? "" : `disabled title="Sign in to react"`}>${emoji}${count ? `<span>${count}</span>` : ""}</button>`;
  }).join("");

  const messages = data?.messages ?? [];
  const moderator = Boolean(data?.moderator);
  feed.innerHTML = (messages.length
    ? messages.map((message) => renderMessage(message, { signedIn, moderator, moderation: Boolean(data?.moderation) })).join("")
    : "")
    + (notice ? `<p class="md-note bn__notice" role="status">${esc(notice)}</p>` : "");
}

// One comment, with the quiet moderation controls the PRD asks for: a report
// link on other people's comments, a label on your own when it is hidden,
// and hide/mute for a moderator. The Worker has already removed anything
// this viewer may not see (src/talkModeration.js), so nothing here hides.
const STATE_LABELS = {
  pending: "Hidden pending review",
  removed: "Removed by a moderator",
  muted: "Author muted",
};

export function renderMessage(message, { signedIn, moderator, moderation }) {
  const label = message.state && message.state !== "visible" ? STATE_LABELS[message.state] : "";
  const tools = [];
  if (moderation && signedIn && message.id != null && !message.mine && !moderator) {
    tools.push(message.reported
      ? `<span class="bn-msg__tool is-done">Reported</span>`
      : `<button type="button" class="bn-msg__tool" data-talk-action="report" data-message-id="${message.id}">Report</button>`);
  }
  if (moderator && message.id != null) {
    if (message.reports) tools.push(`<span class="bn-msg__tool is-done">${message.reports} report${message.reports === 1 ? "" : "s"}</span>`);
    tools.push(message.state === "removed"
      ? `<button type="button" class="bn-msg__tool" data-talk-action="unhide" data-message-id="${message.id}">Unhide</button>`
      : `<button type="button" class="bn-msg__tool" data-talk-action="hide" data-message-id="${message.id}">Hide</button>`);
    if (!message.mine) {
      tools.push(message.state === "muted"
        ? `<button type="button" class="bn-msg__tool" data-talk-action="unmute" data-message-id="${message.id}">Unmute author</button>`
        : `<button type="button" class="bn-msg__tool" data-talk-action="mute" data-message-id="${message.id}">Mute author</button>`);
    }
  }
  return `<div class="bn-msg ${message.pending ? "is-pending" : ""} ${label ? "is-hidden" : ""}">`
    + `<span class="bn-msg__name">${esc(message.name)}</span><span class="bn-msg__text">${esc(message.text)}</span>`
    + (label ? `<span class="bn-msg__state">${label}</span>` : "")
    + (tools.length ? `<span class="bn-msg__tools">${tools.join("")}</span>` : "")
    + `</div>`;
}

function scrollFeed() {
  const feed = node?.querySelector("[data-bn-feed]");
  if (feed) feed.scrollTop = feed.scrollHeight;
}
