import * as Y from 'yjs';
import DocState from '../models/DocState.js';
import { verifyToken, signAccessToken } from '../utils/token.js';
import { findWorkspace, findMember, pendingOf, publicView } from './workspaceStore.js';
import * as svc from './workspaceService.js';
import * as rt from './realtime.js';
import * as logs from './updateLogService.js';

/**
 * Blueprint Part 13 - Socket Events, now gated.
 *
 * The Yjs relay is UNCHANGED from Milestone 0: the server keeps one authoritative
 * Y.Doc per workspace and moves opaque binary updates around. What is new is the
 * turnstile in front of it — io.use() decides who may speak to the document.
 *
 * Two classes of socket:
 *   kind = 'access'  -> a member. Joins ws:<id>, gets sync + awareness.
 *   kind = 'lobby'   -> someone awaiting approval. Joins lobby:<id>:<req> ONLY.
 *                       No sync handler is even registered for them, so they
 *                       cannot see the document, the cursors, or the peer list.
 *
 * Replay (Blueprint 8.4 + Part 13) rides the same relay rather than adding a
 * second channel: every update that is broadcast is also appended to the room's
 * update log, and 'get-replay-logs' hands that log back. Because the handler is
 * registered inside the member branch, history inherits the existing access
 * boundary exactly - a lobby socket cannot read the past any more than the
 * present.
 */

// workspaceId -> { doc, dirty, timer }
const rooms = new Map();

// ---- replay transfer tuning ---------------------------------------------
// A chunk closes when EITHER limit is reached. 400 entries keeps the JSON
// side (sizes + framing) small; 512 KB bounds the binary side so one chunk
// with a few large stroke/image updates cannot balloon a single ws frame.
const REPLAY_CHUNK_ENTRIES = 400;
const REPLAY_CHUNK_BYTES = 512 * 1024;

/**
 * A stored payload arrives in different shapes depending on the store:
 * a Node Buffer (memory mode), a BSON Binary via Mongoose .lean() (Mongo
 * mode, exposes .buffer), or - defensively - a plain Uint8Array or a
 * serialised { type:'Buffer', data:[...] }. Normalise all of them to a
 * Buffer, or null if the row is unreadable.
 */
function toStoredBytes(payload) {
  if (!payload) return null;
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  const inner = payload.buffer; // BSON Binary
  if (inner) {
    if (Buffer.isBuffer(inner)) return inner;
    if (inner instanceof Uint8Array) {
      return Buffer.from(inner.buffer, inner.byteOffset, inner.byteLength);
    }
  }
  if (Array.isArray(payload)) return Buffer.from(payload);
  if (Array.isArray(payload.data)) return Buffer.from(payload.data);
  return null;
}

let persistenceEnabled = false;
export function setPersistence(flag) {
  persistenceEnabled = flag;
}

async function getRoom(workspaceId) {
  if (rooms.has(workspaceId)) return rooms.get(workspaceId);

  const doc = new Y.Doc();

  if (persistenceEnabled) {
    try {
      const saved = await DocState.findOne({ roomId: workspaceId }).lean();
      if (saved?.state) {
        Y.applyUpdate(doc, new Uint8Array(saved.state));
        console.log(`[yjs] "${workspaceId}" restored from MongoDB`);
      }
    } catch (err) {
      console.warn('[yjs] restore failed:', err.message);
    }
  }

  // ---- replay baseline ------------------------------------------------
  // A room can legitimately have a docstate snapshot but an EMPTY update log:
  // the board was drawn before this feature existed, or the log was cleared.
  // Replaying that room would start from a blank canvas and then jump, which
  // would be a lie about its history. So when we restore a non-empty document
  // into a room with no log, we record the restored state as seq 0 - replay
  // then begins at "everything that existed when recording started", which is
  // both true and the only thing we can honestly claim.
  //
  // An empty Y.Doc encodes to exactly 2 bytes, so this seeds nothing for a
  // genuinely fresh room.
  try {
    const state = Y.encodeStateAsUpdate(doc);
    if (state.length > 2 && (await logs.countLogs(workspaceId)) === 0) {
      await logs.appendUpdate(workspaceId, state, { username: 'snapshot' });
      console.log(`[replay] "${workspaceId}" log seeded from the restored snapshot`);
    }
  } catch (err) {
    console.warn('[replay] baseline seed skipped:', err.message);
  }

  const entry = { doc, dirty: false, timer: null };

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
          { roomId: workspaceId },
          { roomId: workspaceId, state },
          { upsert: true }
        );
      } catch (err) {
        console.warn('[yjs] snapshot failed:', err.message);
      }
    }, 2000);
  });

  rooms.set(workspaceId, entry);
  return entry;
}

// ---------------------------------------------------------------- handshake

async function authenticate(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('AUTH_REQUIRED'));

  const payload = verifyToken(token);
  if (!payload) return next(new Error('AUTH_INVALID'));

  const workspace = await findWorkspace(payload.workspaceId);
  if (!workspace) return next(new Error('WORKSPACE_NOT_FOUND'));
  if (workspace.status === 'closed') return next(new Error('WORKSPACE_CLOSED'));

  if (payload.kind === 'access') {
    // Membership is re-checked on EVERY connect, so a removed user's token dies
    // immediately and we never have to maintain a revocation list.
    const member = findMember(workspace, payload.userId);
    if (!member) return next(new Error('NOT_A_MEMBER'));

    socket.data = {
      kind: 'access',
      workspaceId: workspace.workspaceId,
      userId: payload.userId,
      username: member.username,
      role: member.role
    };
    return next();
  }

  if (payload.kind === 'lobby') {
    socket.data = {
      kind: 'lobby',
      workspaceId: workspace.workspaceId,
      requestId: payload.requestId,
      username: payload.username
    };
    return next();
  }

  return next(new Error('AUTH_INVALID'));
}

// ------------------------------------------------------------------- setup

export function setupSocket(io) {
  rt.bindIo(io);

  io.use((socket, next) => {
    authenticate(socket, next).catch(() => next(new Error('AUTH_INVALID')));
  });

  io.on('connection', async (socket) => {
    const { kind, workspaceId } = socket.data;

    // ===================================================================
    //  WAITING ROOM SOCKET
    // ===================================================================
    if (kind === 'lobby') {
      const { requestId, username } = socket.data;
      socket.join(rt.lobbyOf(workspaceId, requestId));

      // Handles "the user refreshed the waiting page" — replay whatever already
      // happened rather than leaving them on a spinner forever.
      const status = await svc.getRequestStatus({ workspaceId, requestId });

      if (!status.ok) {
        socket.emit('join:rejected', { reason: 'Your request is no longer valid.' });
      } else if (status.request.status === 'approved') {
        const member = (status.workspace.members || []).find(
          (m) => m.username.toLowerCase() === username.toLowerCase()
        );
        if (member) {
          socket.emit('join:approved', {
            token: signAccessToken({
              workspaceId,
              userId: member.userId,
              username: member.username,
              role: member.role
            }),
            workspace: publicView(status.workspace)
          });
        }
      } else if (status.request.status === 'rejected') {
        socket.emit('join:rejected', {
          reason: 'The administrator declined your request to join.'
        });
      } else {
        socket.emit('join:waiting', { requestId, username });
        // Re-announce, in case the admin connected AFTER the request landed.
        rt.toAdmin(workspaceId, 'join:requested', { request: status.request });
      }

      return; // no sync handler, no awareness handler. Nothing else is wired up.
    }

    // ===================================================================
    //  MEMBER SOCKET — the Milestone 0 collaborative socket
    // ===================================================================
    const { userId, username, role } = socket.data;

    socket.join(rt.roomOf(workspaceId));
    if (role === 'admin') socket.join(rt.adminRoomOf(workspaceId));

    const { doc } = await getRoom(workspaceId);
    socket.emit('sync-update', Y.encodeStateAsUpdate(doc));

    const broadcastPresence = () => {
      rt.toWorkspace(workspaceId, 'room-info', {
        workspaceId,
        users: rt.connectedCount(workspaceId),
        connected: rt.connectedUsers(workspaceId)
      });
    };
    broadcastPresence();

    // The admin picks up anything that piled up while they were offline.
    if (role === 'admin') {
      const workspace = await findWorkspace(workspaceId);
      socket.emit('join:pending', { requests: pendingOf(workspace) });
    }

    console.log(`[socket] ${username} (${role}) -> ${workspaceId}`);

    // ---- Yjs relay: byte for byte the original behaviour ---------------
    socket.on('sync-update', async (update) => {
      const bytes = new Uint8Array(update);
      const room = await getRoom(workspaceId);
      Y.applyUpdate(room.doc, bytes, socket.id);
      socket.to(rt.roomOf(workspaceId)).emit('sync-update', bytes);

      // Blueprint 8.4 - history is appended AFTER the relay, on purpose.
      // Collaborators must never wait on a database write to see each other's
      // edits, and appendUpdate() swallows its own errors, so a broken log can
      // slow down or disable replay but can never stall or break live sync.
      logs.appendUpdate(workspaceId, bytes, { userId, username });
    });

    socket.on('awareness-update', (update) => {
      socket.to(rt.roomOf(workspaceId)).emit('awareness-update', new Uint8Array(update));
    });

    // ---- Blueprint Part 13: replay ------------------------------------
    // Registered HERE, inside the member branch, which is the whole access
    // story: a lobby socket returned long before this line, so someone waiting
    // for approval cannot ask for the history any more than they can ask for
    // the document. The room is read from socket.data (set from the signed
    // token at handshake), never from the request, so this cannot be used to
    // read another workspace's history either.
    //
    // WHY THE HISTORY IS STREAMED, AND WHY EACH CHUNK PACKS ITS PAYLOADS
    // INTO ONE BUFFER — this is the fix for the "replay works for tiny
    // drawings, times out for real ones" bug:
    //
    // socket.io encodes every Buffer nested anywhere inside an emitted value
    // as a SEPARATE binary attachment, and socket.io-parser >= 4.2.5 (pulled
    // in by both our server and client) hard-refuses any packet carrying more
    // than 10 attachments as a DoS defence. The old handler shipped the whole
    // log in one emit with one Buffer PER ENTRY, so any session past ~10
    // updates produced a packet the client's parser rejected — the client
    // tore the connection down with "parse error", the response never
    // arrived, and the UI's timer showed a false "server did not answer".
    //
    // The protocol below never puts more than ONE attachment in a message,
    // no matter how long the session is:
    //
    //   replay-logs-begin  { count, capped, meta:[{seq,timestamp,username,size}] }
    //   replay-logs-chunk  { start, count, sizes:[...], data: <one packed Buffer> }  (repeated)
    //   replay-logs-end    { count }
    //   replay-logs-error  { code, message }          (instead of any of the above)
    //
    // Chunking also bounds per-message size, lets the client show real
    // progress, and the setImmediate() between chunks yields the event loop
    // so serving a long history can never starve live collaboration.
    socket.on('get-replay-logs', async (_payload, ack) => {
      const fail = (code, message) => {
        socket.emit('replay-logs-error', { workspaceId, code, message });
        ack?.({ ok: false, code, message });
      };

      let raw;
      try {
        raw = await logs.getLogs(workspaceId);
      } catch (err) {
        console.error('[replay] history read failed:', err.message);
        return fail('DB_READ_FAILED', 'The session history could not be read from storage.');
      }

      try {
        // Normalise every stored payload up front. In memory mode these are
        // Buffers; in Mongo mode .lean() can hand back BSON Binary objects.
        // A single corrupt row is skipped (and reported) rather than allowed
        // to abort the entire fetch.
        const rows = [];
        for (const e of raw) {
          const bytes = toStoredBytes(e.payload);
          if (!bytes || !bytes.length) continue;
          rows.push({
            seq: e.seq,
            // ms since epoch: survives JSON, and the client only ever formats it
            timestamp: new Date(e.timestamp).getTime(),
            username: e.username || null,
            bytes
          });
        }

        const count = rows.length;
        const capped = raw.length >= logs.MAX_LOGS_PER_ROOM;

        socket.emit('replay-logs-begin', {
          workspaceId,
          count,
          capped,
          skipped: raw.length - count, // corrupt/empty rows we could not ship
          meta: rows.map((r) => ({
            seq: r.seq, timestamp: r.timestamp, username: r.username, size: r.bytes.length
          }))
        });
        // The ack answers a SUMMARY, never the payloads — an ack is a single
        // packet and would hit the exact same attachment ceiling.
        ack?.({ ok: true, streamed: true, count, capped });

        let i = 0;
        while (i < count) {
          const start = i;
          const sizes = [];
          const parts = [];
          let chunkBytes = 0;
          while (
            i < count &&
            sizes.length < REPLAY_CHUNK_ENTRIES &&
            (chunkBytes === 0 || chunkBytes + rows[i].bytes.length <= REPLAY_CHUNK_BYTES)
          ) {
            sizes.push(rows[i].bytes.length);
            parts.push(rows[i].bytes);
            chunkBytes += rows[i].bytes.length;
            i++;
          }
          if (!socket.connected) return; // the viewer left mid-transfer: stop quietly
          socket.emit('replay-logs-chunk', {
            workspaceId,
            start,
            count: sizes.length,
            sizes,
            data: Buffer.concat(parts) // exactly ONE binary attachment per chunk
          });
          // Yield between chunks so a huge history can never block the relay.
          await new Promise((r) => setImmediate(r));
        }

        socket.emit('replay-logs-end', { workspaceId, count });
      } catch (err) {
        console.error('[replay] get-replay-logs failed:', err.message);
        fail('REPLAY_INTERNAL', 'Internal replay processing error.');
      }
    });

    // ---- administrator actions ----------------------------------------
    // Authority comes from socket.data, which was set at handshake time from a
    // SIGNED token. Never from the payload. A member emitting 'admin:approve'
    // receives an error, not an approval.
    const asAdmin = (handler) => async (payload, ack) => {
      if (socket.data.role !== 'admin') {
        return ack?.({ ok: false, message: 'Only the administrator can do that.' });
      }
      try {
        const result = await handler(payload || {});
        ack?.(result.ok ? result : { ok: false, message: result.message });
      } catch (err) {
        console.error('[socket] admin action failed:', err.message);
        ack?.({ ok: false, message: 'Something went wrong. Please try again.' });
      }
    };

    socket.on('admin:approve', asAdmin(({ requestId }) =>
      svc.approveRequest({ workspaceId, requestId })
    ));

    socket.on('admin:reject', asAdmin(({ requestId, reason }) =>
      svc.rejectRequest({ workspaceId, requestId, reason })
    ));

    socket.on('admin:set-policy', asAdmin(({ permissionMode }) =>
      svc.setPermissionMode({ workspaceId, permissionMode })
    ));

    socket.on('admin:remove-user', asAdmin(({ userId: target }) =>
      svc.removeMember({ workspaceId, userId: target, actorId: userId })
    ));

    socket.on('admin:pending', asAdmin(async () => {
      const workspace = await findWorkspace(workspaceId);
      return { ok: true, requests: pendingOf(workspace) };
    }));

    socket.on('disconnect', () => broadcastPresence());
  });
}
