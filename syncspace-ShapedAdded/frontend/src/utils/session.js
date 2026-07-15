/**
 * Where the workspace access token lives.
 *
 * sessionStorage (not localStorage) on purpose: a token is scoped to ONE browser
 * tab and one workspace. Open a second tab as a different user and the two do not
 * fight over each other — which is exactly how you demo this thing.
 */

const key = (workspaceId) => `syncspace:${workspaceId}`;
const TICKET = "syncspace:ticket";

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
