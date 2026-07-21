import { useNavigate } from "react-router-dom";

/**
 * The app no longer drops you straight into a room. Two doors, that is all.
 */
export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="centered">
      <div className="card wide">
        <h1 className="logo">SyncSpace</h1>
        <p className="sub">
          A secure, real-time whiteboard and code editor. Create a workspace and
          invite your team, or join one you have been given the code for.
        </p>

        <div className="choices">
          <button className="choice" onClick={() => navigate("/create")}>
            <span className="choice-icon">+</span>
            <span className="choice-title">Create Workspace</span>
            <span className="choice-desc">
              You become the administrator. Set a secret code and decide how people get in.
            </span>
          </button>

          <button className="choice" onClick={() => navigate("/join")}>
            <span className="choice-icon">&#8594;</span>
            <span className="choice-title">Join Workspace</span>
            <span className="choice-desc">
              Enter a workspace ID and its secret code to request access.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
