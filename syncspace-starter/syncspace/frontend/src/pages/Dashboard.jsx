import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('demo');
  const navigate = useNavigate();

  const join = () => {
    const finalName = name.trim() || 'Anonymous';
    const finalRoom = room.trim() || 'demo';
    sessionStorage.setItem('syncspace-user', finalName);
    navigate(`/room/${encodeURIComponent(finalRoom)}`);
  };

  return (
    <div className="dash">
      <div className="card">
        <h1>SyncSpace</h1>
        <p className="sub">Real-time collaborative whiteboard + code editor</p>

        <label>Your name</label>
        <input
          value={name}
          placeholder="Serah"
          onChange={(e) => setName(e.target.value)}
        />

        <label>Room ID</label>
        <input
          value={room}
          placeholder="demo"
          onChange={(e) => setRoom(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && join()}
        />

        <button className="btn" onClick={join}>Join room</button>
        <p className="hint">
          Open the same room ID in a second browser window to see the sync.
        </p>
      </div>
    </div>
  );
}
