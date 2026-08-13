import { useState } from "react";
import AIMessage from "./AIMessage.jsx";

function getPlaceholder(action) {
  switch (action) {
    case "explain":
      return "Paste the code you want me to explain...";

    case "generate":
      return "Describe the code you want to generate...";

    case "error":
      return "Paste the error message here...";

    case "debug":
      return "Describe the bug or paste the error...";

    case "tests":
      return "Paste the function or program...";

    case "optimize":
      return "Paste the code you want to optimize...";

    case "convert":
      return "Paste the code you want to convert...";

    case "document":
      return "Paste the code you want documented...";

    default:
      return "Ask SyncSpace AI...";
  }
}

export default function AIChat({
  activeAction,
  onSubmit,
  loading,
  messages
}) {
  const [input, setInput] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();

    const value = input.trim();

    if (!value || loading) {
      return;
    }

    setInput("");

    await onSubmit(value);
  };

  return (
    <section className="ai-chat">
      <div className="ai-messages">
        {messages.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty-icon">✦</div>

            <h2>How can SyncSpace AI help?</h2>

            <p>
              Ask programming questions or choose an AI
              development tool above.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <AIMessage
              key={message.id}
              role={message.role}
              content={message.content}
            />
          ))
        )}

        {loading && (
          <div className="ai-message-row assistant">
            <div className="ai-message-label">
              SyncSpace AI
            </div>

            <div className="ai-message-content ai-loading">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      <form
        className="ai-input-area"
        onSubmit={handleSubmit}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={getPlaceholder(activeAction)}
          rows={4}
          disabled={loading}
          maxLength={30000}
        />

        <button
          type="submit"
          disabled={!input.trim() || loading}
        >
          {loading ? "Working..." : "Send"}
        </button>
      </form>
    </section>
  );
}