import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness';
import { createSocket, colorFor } from '../utils/socket';

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

  return { ...(ctx || {}), connected, peers, pendingRequests, workspace, fatal, admin };
}
