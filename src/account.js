import { DATA_API } from "./data.js";

// Accounts: Google sign-in via Google Identity Services, an opaque bearer session
// from the Worker kept in localStorage, followed clubs and notification prefs.
// Everything is additive: with no Worker, no D1, or no Google client id configured,
// the You section explains itself instead of erroring.

const SESSION_KEY = "gs-session";
const GIS_SRC = "https://accounts.google.com/gsi/client";

// The Google OAuth *web client id* (public by design, not a secret). Must list the
// site origin and http://localhost:8731 as authorized JavaScript origins. Empty
// means sign-in shows a "not configured" note.
export const GOOGLE_CLIENT_ID = "";

let session = readSession();
let account = null; // { user, follows } after /me or sign-in
let listeners = new Set();

export function accountAvailable() {
  return Boolean(DATA_API);
}

export function currentAccount() {
  return account;
}

export function isSignedIn() {
  return Boolean(session && account);
}

export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(account));
}

function readSession() {
  try {
    return window.localStorage.getItem(SESSION_KEY) || null;
  } catch {
    return null;
  }
}

function storeSession(token) {
  session = token;
  try {
    if (token) window.localStorage.setItem(SESSION_KEY, token);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage blocked; the session lives for this page only
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (session) headers.Authorization = `Bearer ${session}`;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${DATA_API}${path}`, { ...options, headers });
  if (!response.ok) {
    const error = new Error(`account api ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// Restore the signed-in state on boot. 401 means the stored session expired.
export async function restoreAccount() {
  if (!accountAvailable() || !session) return null;
  try {
    account = await api("/me");
    emit();
    return account;
  } catch (error) {
    if (error.status === 401) storeSession(null);
    account = null;
    return null;
  }
}

// Lazily load Google Identity Services and render the official button into the
// given container. GIS requires its own rendered button for the credential flow.
let gisLoading = null;

function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("gis load failed"));
    document.head.appendChild(script);
  });
  return gisLoading;
}

export async function mountSignIn(container, { onSignedIn, onError }) {
  if (!container) return;
  try {
    await loadGis();
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        try {
          const result = await api("/auth/google", {
            method: "POST",
            body: JSON.stringify({ credential: response.credential }),
          });
          storeSession(result.token);
          account = { user: result.user, follows: result.follows };
          emit();
          onSignedIn?.(account);
        } catch (error) {
          onError?.(error);
        }
      },
    });
    window.google.accounts.id.renderButton(container, {
      theme: "filled_black",
      size: "large",
      shape: "pill",
      text: "continue_with",
      width: 260,
    });
  } catch (error) {
    onError?.(error);
  }
}

export async function signOut() {
  try {
    if (session) await api("/auth/logout", { method: "POST" });
  } catch {
    // best-effort; the local session is dropped regardless
  }
  storeSession(null);
  account = null;
  emit();
}

export async function toggleFollow(competition, team) {
  const result = await api("/follows/toggle", {
    method: "POST",
    body: JSON.stringify({ competition, team }),
  });
  if (account) account.follows = result.follows;
  emit();
  return result.follows;
}

export async function savePrefs(prefs) {
  const result = await api("/prefs", { method: "POST", body: JSON.stringify({ prefs }) });
  if (account) account.user.prefs = result.prefs;
  emit();
  return result.prefs;
}

export function isFollowed(competition, team) {
  return Boolean(
    account?.follows?.some((f) => f.competition === competition && f.team === team),
  );
}
