import { useNavigate } from "react-router";
import { useAuth } from "../hooks/useAuth";

/**
 * Landing page — a modern marketing-style splash that introduces SyncSpace
 * and funnels the user toward the two existing doors: Create or Join.
 * All navigation targets match the routes defined in App.jsx.
 */
export default function Landing() {
  const navigate = useNavigate();
  const { account, ready, logout } = useAuth();

  return (
    <div className="landing">
      {/* ---- top navigation bar ---- */}
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <span className="landing-brand">
            <span className="landing-brand-mark">S</span>
            <span className="landing-brand-name">SyncSpace</span>
          </span>
          <nav className="landing-links">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#collab">Collaboration</a>
          </nav>
          {ready && account ? (
            <div className="landing-account">
              <button className="landing-account-name" onClick={() => navigate("/dashboard")}>
                {account.username}
              </button>
              <button className="landing-cta-sm" onClick={() => navigate("/dashboard")}>
                My Workspaces
              </button>
              <button className="landing-cta-sm ghost" onClick={logout}>
                Sign out
              </button>
            </div>
          ) : (
            <div className="landing-account">
              <button className="landing-cta-sm ghost" onClick={() => navigate("/login")}>
                Sign in
              </button>
              <button className="landing-cta-sm" onClick={() => navigate("/join")}>
                Join Workspace
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ---- hero section ---- */}
      <section className="landing-hero">
        <div className="landing-hero-bg" aria-hidden="true" />
        <div className="landing-hero-content">
          <div className="landing-badge">
            <span className="landing-badge-dot" />
            Real-time, secure, collaborative
          </div>
          <h1 className="landing-title">
            Code, sketch &amp; brainstorm
            <br />
            <span className="landing-title-accent">together in real time.</span>
          </h1>
          <p className="landing-subtitle">
            SyncSpace unites a live code editor, an infinite whiteboard, built-in
            chat and full session replay in one beautiful workspace. Create a
            room, share the code, and watch ideas take shape together.
          </p>

          <div className="landing-actions">
            <button className="landing-btn primary" onClick={() => navigate("/create")}>
              <span className="landing-btn-plus">+</span>
              Create a Workspace
            </button>
            <button className="landing-btn ghost" onClick={() => navigate("/join")}>
              Join Workspace
              <span className="landing-btn-arrow">&#8594;</span>
            </button>
          </div>

          <div className="landing-stats">
            <div className="landing-stat">
              <strong>Live sync</strong>
              <span>Zero-lag updates</span>
            </div>
            <div className="landing-stat">
              <strong>5 languages</strong>
              <span>Run code remotely</span>
            </div>
            <div className="landing-stat">
              <strong>Full replay</strong>
              <span>Revisit every edit</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- features section ---- */}
      <section className="landing-section" id="features">
        <div className="landing-section-head">
          <h2>Everything your team needs</h2>
          <p>One shared space for code, design and collaboration.</p>
        </div>
        <div className="landing-features">
          <div className="landing-feature">
            <div className="landing-feature-icon">&#128467;</div>
            <h3>Real-time Code Editor</h3>
            <p>
              A full IDE powered by Monaco with collaborative cursors. Write in
              Python, C, C++, Java or JavaScript and run it instantly against a
              sandboxed remote provider.
            </p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#9998;</div>
            <h3>Infinite Whiteboard</h3>
            <p>
              Draw freehand, drop shapes and stickers, connect ideas with
              connectors and upload images. Every stroke syncs live across the
              whole team.
            </p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#128172;</div>
            <h3>Built-in Chat</h3>
            <p>
              Keep the conversation flowing without leaving the workspace.
              See who's typing and get notified the moment someone messages you.
            </p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#128257;</div>
            <h3>Session Replay</h3>
            <p>
              Scrub back through the entire history of a workspace — every code
              change, every shape move — to see exactly how the work came together.
            </p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#128274;</div>
            <h3>Secure Access</h3>
            <p>
              Workspaces are protected by secret codes and admin-controlled
              approval. You decide who gets in and what they can do.
            </p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#128101;</div>
            <h3>Live Presence</h3>
            <p>
              See who's online at a glance, who is the admin, and who is actively
              editing. Teamwork becomes transparent and effortless.
            </p>
          </div>
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="landing-section landing-steps" id="how">
        <div className="landing-section-head">
          <h2>Up and running in seconds</h2>
          <p>Three simple steps from landing to collaborating.</p>
        </div>
        <div className="landing-steps-grid">
          <div className="landing-step">
            <span className="landing-step-num">1</span>
            <h3>Create a workspace</h3>
            <p>Set a secret code and choose how people get in.</p>
          </div>
          <div className="landing-step">
            <span className="landing-step-num">2</span>
            <h3>Share the code</h3>
            <p>Send your teammates the workspace ID and secret.</p>
          </div>
          <div className="landing-step">
            <span className="landing-step-num">3</span>
            <h3>Collaborate live</h3>
            <p>Code, draw and chat together in real time.</p>
          </div>
        </div>
      </section>

      {/* ---- collaboration CTA ---- */}
      <section className="landing-cta" id="collab">
        <h2>Ready to build something together?</h2>
        <p>Spin up a workspace in seconds and invite your team.</p>
        <div className="landing-actions center">
          <button className="landing-btn primary" onClick={() => navigate("/create")}>
            <span className="landing-btn-plus">+</span>
            Create a Workspace
          </button>
          <button className="landing-btn ghost" onClick={() => navigate("/join")}>
            Join Workspace
            <span className="landing-btn-arrow">&#8594;</span>
          </button>
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className="landing-footer">
        <span className="landing-brand">
          <span className="landing-brand-mark">S</span>
          <span className="landing-brand-name">SyncSpace</span>
        </span>
        <p>
          A secure, real-time whiteboard and code editor for collaborative teams.
        </p>
        <span className="landing-footer-note">Open source &middot; Built with React, Node &middot; WebSocket powered</span>
      </footer>
    </div>
  );
}
