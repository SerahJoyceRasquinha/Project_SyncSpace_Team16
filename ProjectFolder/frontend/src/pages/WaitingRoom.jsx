import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { createSocket } from '../utils/socket';
import { loadTicket, clearTicket, saveSession } from '../utils/session';

/**
 * The lobby.
 *
 * We connect with a LOBBY TICKET, not an access token. The server puts this socket
 * into lobby:<workspaceId>:<requestId> and registers no sync handlers for it at
 * all — so while this page is open the user genuinely cannot read the document,
 * see cursors, or discover who else is in the room.
 *
 * When the admin clicks Approve, the server pushes an access token down THIS
 * socket. No polling, no refresh.
 */
export default function WaitingRoom() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('connecting'); // connecting | waiting | rejected | error
  const [message, setMessage] = useState('');
  const ticket = loadTicket();

  useEffect(() => {
    // Refreshed with no ticket in this tab? There is nothing to wait for.
    if (!ticket || ticket.workspaceId !== workspaceId) {
      setStatus('error');
      setMessage('We could not find your join request. Please request access again.');
      return;
    }

    const socket = createSocket(ticket.ticket);

    socket.on('connect_error', () => {
      setStatus('error');
      setMessage('Your request has expired. Please request access again.');
    });

    socket.on('join:waiting', () => setStatus('waiting'));

    socket.on('join:approved', ({ token }) => {
      saveSession(workspaceId, { token, username: ticket.username, role: 'member' });
      clearTicket();
      socket.disconnect();
      navigate(`/workspace/${workspaceId}`, { replace: true });
    });

    socket.on('join:rejected', ({ reason }) => {
      setStatus('rejected');
      setMessage(reason || 'The administrator declined your request to join.');
      clearTicket();
    });

    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  if (status === 'rejected' || status === 'error') {
    return (
      <div className="centered">
        <div className="card">
          <div className="state-icon denied">&#10005;</div>
          <h1>{status === 'rejected' ? 'Request declined' : 'Something went wrong'}</h1>
          <p className="sub">{message}</p>
          <Link to="/join" className="btn block">Try again</Link>
          <Link to="/" className="hint center-link">Back to home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="centered">
      <div className="card">
        <div className="spinner" />
        <h1>Waiting for administrator approval…</h1>
        <p className="sub">
          Your request has been sent to the administrator of{' '}
          <span className="mono">{workspaceId}</span>. This page will move on by
          itself the moment they respond.
        </p>
        <div className="alert info">Please do not close this page.</div>
        <div className="waiting-meta">
          <span>Joining as</span>
          <strong>{ticket?.username}</strong>
        </div>
      </div>
    </div>
  );
}
