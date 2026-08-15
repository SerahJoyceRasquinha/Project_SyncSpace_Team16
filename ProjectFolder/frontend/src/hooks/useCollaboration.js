import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness';
import { createSocket, colorFor } from '../utils/socket';
import { unpackChunk } from '../canvas/replay.js';

/**
 * Our Yjs "provider" over Socket.io. The sync core is UNCHANGED from Milestone 0:
 *
 *   local edit  -> ydoc 'update' -> socket.emit('sync-update', bytes)
 *   remote edit -> socket.on('sync-update') -> Y.applyUpdate(ydoc, bytes, 'remote')
 *
 * The 'remote' origin tag is what stops the infinite echo loop.
 *
 * NEW: the socket carries a signed access token, and the same connection also
 * carries the workspace-management channel (join requests, policy changes,
 * removal) so the admin panel needs no second socket.
 */
export function useCollaboration(workspaceId, session) {
  const [ctx, setCtx] = useState(null);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [fatal, setFatal] = useState(null); // removed / closed / auth failure
  const socketRef = useRef(null);

  useEffect(() => {
    if (!workspaceId || !session?.token) return;

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const socket = createSocket(session.token);
    socketRef.current = socket;

    awareness.setLocalStateField('user', {
      name: session.username,
      color: colorFor(session.username),
      role: session.role
    });

    // ---- outgoing -------------------------------------------------------
    const onDocUpdate = (update, origin) => {
      if (origin === 'remote') return;
      socket.emit('sync-update', update);
    };
    ydoc.on('update', onDocUpdate);

    const onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return;
      const changed = [...added, ...updated, ...removed];
      socket.emit('awareness-update', encodeAwarenessUpdate(awareness, changed));
    };
    awareness.on('update', onAwareness);

    const refreshPeers = () => {
      const list = [];
      awareness.getStates().forEach((state, clientId) => {
        if (state.user) list.push({ clientId, ...state.user });
      });
      setPeers(list);
    };
    awareness.on('change', refreshPeers);

    // ---- incoming: the document ----------------------------------------
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('connect_error', (err) => {
      // Handshake refused. Translate the server's code into plain English.
      const map = {
        AUTH_REQUIRED: 'You are not signed in to this workspace.',
        AUTH_INVALID: 'Your session has expired. Please join again.',
        NOT_A_MEMBER: 'You have been removed from this workspace.',
        WORKSPACE_CLOSED: 'This workspace has been closed by its administrator.',
        WORKSPACE_NOT_FOUND: 'This workspace no longer exists.'
      };
      if (map[err.message]) setFatal(map[err.message]);
    });

    socket.on('sync-update', (update) => {
      Y.applyUpdate(ydoc, new Uint8Array(update), 'remote');
    });

    socket.on('awareness-update', (update) => {
      applyAwarenessUpdate(awareness, new Uint8Array(update), 'remote');
    });

    // ---- incoming: workspace management --------------------------------
    socket.on('room-info', (info) => setWorkspace((w) => ({ ...w, ...info })));

    socket.on('join:pending', ({ requests }) => setPendingRequests(requests || []));

    socket.on('join:requested', ({ request }) => {
      setPendingRequests((list) =>
        list.some((r) => r.requestId === request.requestId) ? list : [...list, request]
      );
    });

    socket.on('join:resolved', ({ requestId }) => {
      setPendingRequests((list) => list.filter((r) => r.requestId !== requestId));
    });

    socket.on('workspace:updated', ({ workspace: ws }) =>
      setWorkspace((w) => ({ ...w, ...ws }))
    );

    socket.on('workspace:policy-changed', ({ permissionMode }) =>
      setWorkspace((w) => ({ ...w, permissionMode }))
    );

    socket.on('workspace:removed', ({ reason }) => setFatal(reason));
    socket.on('workspace:closed', ({ reason }) => setFatal(reason));
    socket.on('workspace:deleted', ({ reason }) => setFatal(reason));

    setCtx({ ydoc, awareness });
    refreshPeers();

    return () => {
      removeAwarenessStates(awareness, [ydoc.clientID], 'unmount');
      awareness.off('update', onAwareness);
      awareness.off('change', refreshPeers);
      ydoc.off('update', onDocUpdate);
      socket.disconnect();
      awareness.destroy();
      ydoc.destroy();
      socketRef.current = null;
      setCtx(null);
    };
  }, [workspaceId, session?.token, session?.username, session?.role]);

  // ---- admin actions: promise wrappers around socket acknowledgements ---
  const emitAdmin = (event, payload) =>
    new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket) return resolve({ ok: false, message: 'Not connected.' });
      socket.emit(event, payload, (res) =>
        resolve(res || { ok: false, message: 'No response from the server.' })
      );
    });

  // ---- replay: Blueprint Part 13 ---------------------------------------
  // Ask the server for this room's update log.
  //
  // The history arrives as a STREAM (replay-logs-begin / -chunk / -end), with
  // every chunk's payloads packed into a single buffer. That wire shape is
  // load-bearing: socket.io encodes each nested Buffer as its own binary
  // attachment and the parser refuses packets with more than 10 of them, so
  // the old single-message response (one Buffer per entry) was rejected by
  // the client for any session past ~10 updates — the connection died with a
  // "parse error" and the fixed 15 s timer then blamed the server for not
  // answering, which was false: it had answered, unreadably.
  //
  // The watchdog is now an INACTIVITY timer, re-armed on every message, so a
  // long transfer that is making progress can never falsely time out, while
  // a genuinely stalled one still fails with a message that says what was
  // actually received. `onProgress` (optional) receives { received, total }
  // as chunks land, so the dialog can show real progress.
  const fetchReplayLogs = (onProgress) =>
    new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        return resolve({ ok: false, message: 'Not connected to this workspace.' });
      }

      const STALL_MS = 12000;
      let meta = null;      // { count, capped } from replay-logs-begin
      let entries = null;   // filled in as chunks arrive
      let received = 0;
      let settled = false;
      let stallTimer = null;

      const cleanup = () => {
        clearTimeout(stallTimer);
        socket.off('replay-logs-begin', onBegin);
        socket.off('replay-logs-chunk', onChunk);
        socket.off('replay-logs-end', onEnd);
        socket.off('replay-logs-error', onError);
        socket.off('disconnect', onDrop);
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => finish({
          ok: false,
          message: meta
            ? `The history transfer stalled (${received} of ${meta.count} updates received). Please try again.`
            : 'The server did not start sending the session history. Please try again.'
        }), STALL_MS);
      };

      const onBegin = (res) => {
        meta = { count: Math.max(0, res?.count | 0), capped: Boolean(res?.capped) };
        const list = Array.isArray(res?.meta) ? res.meta : [];
        entries = list.map((m) => ({
          seq: m?.seq,
          timestamp: m?.timestamp,
          username: m?.username ?? null,
          size: m?.size | 0,
          payload: null
        }));
        armStall();
        onProgress?.({ received: 0, total: meta.count });
        if (meta.count === 0 || entries.length === 0) {
          finish({ ok: true, count: 0, capped: meta.capped, entries: [] });
        }
      };

      const onChunk = (chunk) => {
        if (!meta || !entries) return; // a chunk before begin: ignore
        const slices = unpackChunk(chunk);
        if (!slices) {
          return finish({
            ok: false,
            message: 'The session history arrived corrupted and could not be parsed.'
          });
        }
        const start = Math.max(0, chunk.start | 0);
        for (let j = 0; j < slices.length; j++) {
          const idx = start + j;
          if (idx < entries.length && !entries[idx].payload) {
            entries[idx].payload = slices[j];
            received++;
          }
        }
        armStall();
        onProgress?.({ received, total: meta.count });
        // Completeness, not the end marker, is what resolves — so a lost
        // final packet degrades to the stall message instead of a hang.
        if (received >= entries.length) {
          finish({ ok: true, count: entries.length, capped: meta.capped, entries });
        }
      };

      const onEnd = () => {
        if (!meta || !entries) return;
        if (received >= entries.length) {
          finish({ ok: true, count: entries.length, capped: meta.capped, entries });
        } else {
          finish({
            ok: false,
            message: `The session history arrived incomplete (${received} of ${entries.length} updates). Please try again.`
          });
        }
      };

      const onError = (res) =>
        finish({ ok: false, message: res?.message || 'The server could not read the session history.' });

      const onDrop = () =>
        finish({ ok: false, message: 'The connection was interrupted while loading the session history.' });

      socket.on('replay-logs-begin', onBegin);
      socket.on('replay-logs-chunk', onChunk);
      socket.on('replay-logs-end', onEnd);
      socket.on('replay-logs-error', onError);
      socket.on('disconnect', onDrop);
      armStall();
      socket.emit('get-replay-logs', {});
    });

  const replay = { fetchLogs: fetchReplayLogs };

  const admin = {
    approve: (requestId) => emitAdmin('admin:approve', { requestId }),
    reject: (requestId, reason) => emitAdmin('admin:reject', { requestId, reason }),
    setPolicy: (permissionMode) => emitAdmin('admin:set-policy', { permissionMode }),
    removeUser: (userId) => emitAdmin('admin:remove-user', { userId }),
    refreshPending: async () => {
      const res = await emitAdmin('admin:pending', {});
      if (res.ok) setPendingRequests(res.requests || []);
      return res;
    }
  };

  return { ...(ctx || {}), connected, peers, pendingRequests, workspace, fatal, admin, replay };
}
