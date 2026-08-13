import { Component } from 'react';

/**
 * Why this file exists
 * --------------------
 * React 18's createRoot has one hard rule: if a render-phase exception reaches
 * the root with no error boundary in between, React UNMOUNTS THE ENTIRE TREE.
 * The page keeps running (sockets stay open, JS keeps executing) but every
 * pixel of UI vanishes and only a browser refresh brings it back.
 *
 * That is exactly the failure this project was suffering: one undeclared
 * identifier in PropertyPanel threw on every shape selection and took the whole
 * whiteboard down with it. The identifier is fixed — but the *class* of failure
 * must be made structurally impossible, not just fixed once. These boundaries
 * are that guarantee: a malformed record, a bad brush, an unexpected shape type
 * or a future coding slip now degrades to "that one object doesn't draw"
 * instead of "the app disappeared".
 */

/**
 * App-level boundary. Renders a real, recoverable DOM fallback so the user is
 * never left staring at a blank page.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the full diagnostic in the console instead of swallowing it — the
    // point is to stay visible AND stay debuggable.
    console.error('[SyncSpace] UI error caught by boundary:', error, info?.componentStack);
    this.props.onError?.(error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary">
        <h2>Something went wrong in the interface</h2>
        <p className="error-boundary-msg">{String(error?.message || error)}</p>
        <p className="error-boundary-hint">
          Your board is safe — this only affected the on-screen interface, and
          nothing was lost from the shared document.
        </p>
        <div className="error-boundary-actions">
          <button className="btn-primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn-clear" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
        {error?.stack && (
          <details className="error-boundary-details">
            <summary>Technical details</summary>
            <pre>{error.stack}</pre>
          </details>
        )}
      </div>
    );
  }
}

/**
 * Canvas-level boundary for a SINGLE drawable object.
 *
 * Its fallback is `null`, which is the only safe fallback inside a Konva Layer
 * (a DOM node cannot be mounted there). So a shape that cannot draw simply
 * doesn't draw; the stage, the toolbar, every other shape and the whole React
 * tree stay alive.
 *
 * `resetKey` should be the shape record. When the record changes — the user
 * edits it, undo rolls it back, a collaborator repairs it — the boundary clears
 * and the object gets another chance to render, so a transient bad state is
 * never permanently sticky.
 */
export class ShapeErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, seen: props.resetKey };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.seen) {
      return { failed: false, seen: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error, info) {
    console.error(
      `[SyncSpace] shape "${this.props.shapeId}" (${this.props.shapeType}) failed to render ` +
      `and was skipped. The rest of the board is unaffected.`,
      error,
      info?.componentStack
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default ErrorBoundary;
