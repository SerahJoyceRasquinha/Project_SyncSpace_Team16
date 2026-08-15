/**
 * Where the workspace access token lives.
 *
 * sessionStorage (not localStorage) on purpose: a token is scoped to ONE browser
 * tab and one workspace. Open a second tab as a different user and the two do not
 * fight over each other — which is exactly how you demo this thing.
 */

const key = (workspaceId) => `syncspace:${workspaceId}`;
const TICKET = "syncspace:ticket";
const ACCOUNT = "syncspace:account";

export function saveSession(workspaceId, { token, username, role }) {
  sessionStorage.setItem(key(workspaceId), JSON.stringify({ token, username, role }));
}

export function loadSession(workspaceId) {
  try {
    const raw = sessionStorage.getItem(key(workspaceId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSession(workspaceId) {
  sessionStorage.removeItem(key(workspaceId));
}

// --- waiting-room ticket (survives a refresh of the waiting page) ---

export function saveTicket(data) {
  sessionStorage.setItem(TICKET, JSON.stringify(data));
}

export function loadTicket() {
  try {
    const raw = sessionStorage.getItem(TICKET);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearTicket() {
  sessionStorage.removeItem(TICKET);
}

// --- user account (persists across tabs; powers the dashboard) ---------
// Unlike workspace access tokens, the account token is shared across tabs so
// signing in once is enough everywhere. It only identifies WHO you are — it
// grants no workspace access by itself (that is still per-workspace).

export function saveAccount(user) {
  localStorage.setItem(ACCOUNT, JSON.stringify(user));
}

export function loadAccount() {
  try {
    const raw = localStorage.getItem(ACCOUNT);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearAccount() {
  localStorage.removeItem(ACCOUNT);
}

// --- editor -> AI handoff ----------------------------------------------
// The AI page is a separate route with no access to the workspace's ydoc, so
// the editor's current language (and filename) is stashed here when the user
// presses ✦ AI. Deliberately small: the LANGUAGE, not the code buffer. Sending
// a whole file on every AI request would be input tokens the user never asked
// to spend, and latency they would feel on a one-line question.
//
// This is a DEFAULT, not an instruction. The backend outranks it with anything
// the user explicitly writes ("...in java"), which is exactly the bug this
// handoff exists to make impossible.

const AI_CONTEXT = (workspaceId) => `syncspace:ai:${workspaceId}`;

export function saveAiContext(workspaceId, context) {
  try {
    sessionStorage.setItem(AI_CONTEXT(workspaceId), JSON.stringify(context));
  } catch {
    /* storage full or blocked: the AI page just falls back to auto-detect */
  }
}

export function loadAiContext(workspaceId) {
  try {
    const raw = sessionStorage.getItem(AI_CONTEXT(workspaceId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
