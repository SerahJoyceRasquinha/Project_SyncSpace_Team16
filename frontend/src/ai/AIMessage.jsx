function AIMessage({ role, content }) {
  const isUser = role === "user";

  return (
    <div
      className={`ai-message-row ${
        isUser ? "user" : "assistant"
      }`}
    >
      <div className="ai-message-label">
        {isUser ? "You" : "SyncSpace AI"}
      </div>

      <div className="ai-message-content">
        {content}
      </div>
    </div>
  );
}

export default AIMessage;