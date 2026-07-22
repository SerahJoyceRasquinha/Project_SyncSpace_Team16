import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "syncspace-dev-secret-change-me";

/**
 * Two kinds of signed token, and the difference matters:
 *
 *  ACCESS token  -> "I am an approved member of workspace X."
 *                   Grants the collaborative socket: Yjs sync, awareness, cursors.
 *
 *  LOBBY ticket  -> "I have asked to join workspace X and am waiting."
 *                   Grants ONLY the waiting room. It cannot touch the document.
 *
 * A user in permission mode holds a lobby ticket first, and is handed an access
 * token only when the admin approves. Nothing else upgrades them.
 */

export function signAccessToken({ workspaceId, userId, username, role }) {
  return jwt.sign(
    { kind: "access", workspaceId, userId, username, role },
    SECRET,
    { expiresIn: "12h" }
  );
}

export function signLobbyTicket({ workspaceId, requestId, username }) {
  return jwt.sign(
    { kind: "lobby", workspaceId, requestId, username },
    SECRET,
    { expiresIn: "2h" }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
