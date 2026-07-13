import { useParams, Link } from 'react-router-dom';
import { useCollaboration } from '../hooks/useCollaboration';
import Canvas from '../components/Canvas.jsx';
import Editor from '../components/Editor.jsx';

export default function Workspace() {
  const { roomId } = useParams();
  const userName = sessionStorage.getItem('syncspace-user') || 'Anonymous';
  const { ydoc, awareness, connected, peers } = useCollaboration(roomId, userName);

  if (!ydoc) {
    return <div className="loading">Connecting to room "{roomId}"…</div>;
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <Link to="/" className="brand">SyncSpace</Link>
        <span className="room">room: <b>{roomId}</b></span>
        <span className={'dot ' + (connected ? 'on' : 'off')} />
        <span className="status">{connected ? 'connected' : 'offline'}</span>
        <div className="peers">
          {peers.map((p) => (
            <span key={p.clientId} className="peer" style={{ background: p.color }}>
              {p.name}
            </span>
          ))}
        </div>
      </header>

      <main className="split">
        <Canvas ydoc={ydoc} awareness={awareness} />
        <Editor ydoc={ydoc} awareness={awareness} />
      </main>
    </div>
  );
}
