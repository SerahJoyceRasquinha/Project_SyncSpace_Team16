/**
 * A tiny indirection so controllers can push realtime events without importing
 * socketService (which imports them back -> circular import). Set once at boot.
 */

let io = null;
export function bindIo(instance) {
  io = instance;
}

export const roomOf = (workspaceId) => `ws:${workspaceId}`;
export const adminRoomOf = (workspaceId) => `admin:${workspaceId}`;
export const lobbyOf = (workspaceId, requestId) => `lobby:${workspaceId}:${requestId}`;

/** To everyone collaborating inside the workspace. */
export function toWorkspace(workspaceId, event, payload) {
  io?.to(roomOf(workspaceId)).emit(event, payload);
}

/** To the administrator only (they may have several tabs open). */
export function toAdmin(workspaceId, event, payload) {
  io?.to(adminRoomOf(workspaceId)).emit(event, payload);
}

/** To one specific person sitting in the waiting room. */
export function toLobby(workspaceId, requestId, event, payload) {
  io?.to(lobbyOf(workspaceId, requestId)).emit(event, payload);
}

/** Force-disconnect every socket belonging to a user (used when removing them). */
export function disconnectUser(workspaceId, userId, reason) {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.workspaceId === workspaceId && socket.data?.userId === userId) {
      socket.emit('workspace:removed', { reason });
      socket.disconnect(true);
    }
  }
}

/** How many people are actually connected right now (runtime truth, not DB). */
export function connectedCount(workspaceId) {
  return io?.sockets.adapter.rooms.get(roomOf(workspaceId))?.size || 0;
}

export function connectedUsers(workspaceId) {
  const out = [];
  if (!io) return out;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.workspaceId === workspaceId && socket.data?.kind === 'access') {
      out.push({
        userId: socket.data.userId,
        username: socket.data.username,
        role: socket.data.role
      });
    }
  }
  // one entry per user even if they have several tabs open
  return [...new Map(out.map((u) => [u.userId, u])).values()];
}
