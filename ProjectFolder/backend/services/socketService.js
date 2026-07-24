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
    socket.on('get-replay-logs', async (_payload, ack) => {
      try {
        const entries = await logs.getLogs(workspaceId);
        const response = {
          workspaceId,
          count: entries.length,
          capped: entries.length >= logs.MAX_LOGS_PER_ROOM,
          entries: entries.map((e) => ({
            seq: e.seq,
            // ms since epoch: survives JSON, and the client only ever formats it
            timestamp: new Date(e.timestamp).getTime(),
            username: e.username || null,
            size: e.payload.length,
            payload: Buffer.from(e.payload)
          }))
        };
        // Emit the Blueprint event AND answer the acknowledgement, so either
        // calling convention works for whoever consumes this next.
        socket.emit('replay-logs', response);
        ack?.({ ok: true, ...response });
      } catch (err) {
        console.error('[replay] get-replay-logs failed:', err.message);
        const failure = { workspaceId, count: 0, entries: [], error: 'Could not load the session history.' };
        socket.emit('replay-logs', failure);
        ack?.({ ok: false, message: failure.error });
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
