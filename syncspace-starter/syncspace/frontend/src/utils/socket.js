import { io } from 'socket.io-client';

export const SERVER_URL = 'http://localhost:5000';

/** One fresh socket per workspace mount. */
export function createSocket() {
  return io(SERVER_URL);
}

/** Deterministic colour per user name, for cursors. */
export function colorFor(name = '') {
  const palette = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}
