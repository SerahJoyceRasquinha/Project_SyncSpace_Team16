import * as Y from 'yjs';
import DocState from '../models/DocState.js';

/**
 * Blueprint Part 13 - Socket Events.
 * The server is a dumb, fast relay + an authoritative Y.Doc per room.
 * It never understands "shapes" or "code" - only binary CRDT updates.
 */

// roomId -> { doc: Y.Doc, dirty: boolean, timer }
const rooms = new Map();

let persistenceEnabled = false;
export function setPersistence(flag) {
  persistenceEnabled = flag;
}

async function getRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const doc = new Y.Doc();

  // Rehydrate from MongoDB if we have a snapshot (session recovery).
  if (persistenceEnabled) {
    try {
      const saved = await DocState.findOne({ roomId }).lean();
      if (saved?.state) {
        Y.applyUpdate(doc, new Uint8Array(saved.state));
        console.log(`[yjs] room "${roomId}" restored from MongoDB`);
      }
    } catch (err) {
      console.warn('[yjs] restore failed:', err.message);
    }
  }

  const entry = { doc, dirty: false, timer: null };

  // Debounced snapshot: never write to Mongo on every keystroke.
  doc.on('update', () => {
    if (!persistenceEnabled) return;
    entry.dirty = true;
    if (entry.timer) return;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (!entry.dirty) return;
      entry.dirty = false;
      try {
        const state = Buffer.from(Y.encodeStateAsUpdate(doc));
        await DocState.findOneAndUpdate(
          { roomId },
          { roomId, state },
          { upsert: true }
        );
        console.log(`[yjs] snapshot saved for "${roomId}" (${state.length} bytes)`);
      } catch (err) {
        console.warn('[yjs] snapshot failed:', err.message);
      }
    }, 2000);
  });

  rooms.set(roomId, entry);
  return entry;
}

export function setupSocket(io) {
  io.on('connection', (socket) => {
    console.log('[socket] connected:', socket.id);
    let currentRoom = null;

    // ---- join-room -------------------------------------------------
    socket.on('join-room', async ({ roomId, user }) => {
      if (!roomId) return;
      currentRoom = roomId;
      socket.join(roomId);
      socket.data.user = user;

      const { doc } = await getRoom(roomId);

      // Send the newcomer the FULL current state of the room.
      socket.emit('sync-update', Y.encodeStateAsUpdate(doc));

      const count = io.sockets.adapter.rooms.get(roomId)?.size || 1;
      io.to(roomId).emit('room-info', { roomId, users: count });
      console.log(`[socket] ${socket.id} joined "${roomId}" (${count} online)`);
    });

    // ---- sync-update (the CRDT payload) ----------------------------
    socket.on('sync-update', async (update) => {
      if (!currentRoom) return;
      const { doc } = await getRoom(currentRoom);
      const bytes = new Uint8Array(update);
      Y.applyUpdate(doc, bytes, socket.id);          // merge into server doc
      socket.to(currentRoom).emit('sync-update', bytes); // fan out to peers
    });

    // ---- awareness-update (cursors / names) ------------------------
    socket.on('awareness-update', (update) => {
      if (!currentRoom) return;
      socket.to(currentRoom).emit('awareness-update', new Uint8Array(update));
    });

    socket.on('disconnect', () => {
      if (currentRoom) {
        const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
        io.to(currentRoom).emit('room-info', { roomId: currentRoom, users: count });
      }
      console.log('[socket] disconnected:', socket.id);
    });
  });
}
