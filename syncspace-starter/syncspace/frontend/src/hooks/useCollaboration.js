import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness';
import { createSocket, colorFor } from '../utils/socket';

/**
 * This is our own tiny Yjs "provider" built on Socket.io.
 * (The blueprint's Part 13 event names: join-room / sync-update / awareness-update)
 *
 * Local edit  -> ydoc "update" event -> socket.emit('sync-update', bytes)
 * Remote edit -> socket.on('sync-update') -> Y.applyUpdate(ydoc, bytes, 'remote')
 *
 * The 'remote' origin tag is what stops an infinite echo loop.
 */
export function useCollaboration(roomId, userName) {
  const [ctx, setCtx] = useState(null);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    if (!roomId) return;

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const socket = createSocket();

    awareness.setLocalStateField('user', {
      name: userName || 'Anonymous',
      color: colorFor(userName)
    });

    // --- outgoing document updates ---
    const onDocUpdate = (update, origin) => {
      if (origin === 'remote') return; // came from a peer; don't bounce it back
      socket.emit('sync-update', update);
    };
    ydoc.on('update', onDocUpdate);

    // --- outgoing awareness (cursors, names) ---
    const onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return;
      const changed = [...added, ...updated, ...removed];
      socket.emit('awareness-update', encodeAwarenessUpdate(awareness, changed));
    };
    awareness.on('update', onAwareness);

    // keep a simple list of who's in the room
    const refreshPeers = () => {
      const list = [];
      awareness.getStates().forEach((state, clientId) => {
        if (state.user) list.push({ clientId, ...state.user });
      });
      setPeers(list);
    };
    awareness.on('change', refreshPeers);

    // --- incoming ---
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join-room', { roomId, user: userName });
      // push whatever we already have (e.g. edits made while offline)
      socket.emit('sync-update', Y.encodeStateAsUpdate(ydoc));
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('sync-update', (update) => {
      Y.applyUpdate(ydoc, new Uint8Array(update), 'remote');
    });

    socket.on('awareness-update', (update) => {
      applyAwarenessUpdate(awareness, new Uint8Array(update), 'remote');
    });

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
      setCtx(null);
    };
  }, [roomId, userName]);

  return { ...(ctx || {}), connected, peers };
}
