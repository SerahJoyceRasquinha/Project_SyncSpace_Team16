import { io } from "socket.io-client";

export const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:5000";

/**
 * Every socket now carries a signed token in the handshake. No token, no
 * connection — the server rejects it in io.use() before any event is registered.
 *
 * Pass an ACCESS token to collaborate, or a LOBBY ticket to sit in the waiting
 * room. The server decides what that socket is allowed to do; the client cannot
 * talk its way in.
 */
export function createSocket(token) {
  return io(SERVER_URL, { auth: { token } });
}

/** Deterministic colour per username, for cursors and avatars. */
export function colorFor(name = "") {
  const palette = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}
