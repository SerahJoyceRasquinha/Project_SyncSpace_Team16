import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { aiApi } from "./aiApi.js";
import AIChat from "./AIChat.jsx";
import AIToolbar from "./AIToolbar.jsx";
import { loadSession } from "../utils/session";
import "./ai.css";

export default function AIPage() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();

  const session = workspaceId
    ? loadSession(workspaceId)
    : null;

  const [activeAction, setActiveAction] = useState("chat");
  const [loading, setLoading] = useState(false);

  const [messages, setMessages] = useState([]);

  const addMessage = (role, content) => {
    setMessages((previous) => [
      ...previous,
      {
        id:
          Date.now() +
          "-" +
          Math.random().toString(36).slice(2, 8),
        role,
        content
      }
    ]);
  };

const handleSubmit = async (formData) => {
  const {
    input,
    language,
    targetLanguage,
    error
  } = formData;

  addMessage("user", input);
  setLoading(true);

  try {
    let result;

    const token = session?.token;

    switch (activeAction) {
      case "explain":
        result = await aiApi.explain(
          input,
          language,
          { token }
        );
        break;

      case "generate":
        result = await aiApi.generate(
          input,
          language,
          { token }
        );
        break;

      case "error":
        result = await aiApi.analyzeError(
          error || input,
          "",
          language,
          { token }
        );
        break;

      case "debug":
        result = await aiApi.debug(
          input,
          error,
          language,
          { token }
        );
        break;

      case "tests":
        result = await aiApi.generateTests(
          input,
          language,
          { token }
        );
        break;

      case "optimize":
        result = await aiApi.optimize(
          input,
          language,
          { token }
        );
        break;

      case "convert":
        result = await aiApi.convert(
          input,
          language,
          targetLanguage,
          { token }
        );
        break;

      case "document":
        result = await aiApi.document(
          input,
          language,
          { token }
        );
        break;

      case "chat":
      default:
        result = await aiApi.chat(
          input,
          { token }
        );
        break;
    }

    addMessage(
      "assistant",
      result.answer || "The AI returned no answer."
    );
  } catch (error) {
    addMessage(
      "assistant",
      `Error: ${error.message}`
    );
  } finally {
    setLoading(false);
  }
};

  const handleBack = () => {
    if (workspaceId) {
      navigate(`/workspace/${workspaceId}`);
      return;
    }

    navigate("/");
  };

  return (
    <main className="ai-page">
      <header className="ai-header">
        <div className="ai-brand">
          <button
            type="button"
            className="ai-back"
            onClick={handleBack}
          >
            ←
          </button>

          <div>
            <h1>✦ SyncSpace AI</h1>

            <p>
              Independent AI-powered development assistant
            </p>
          </div>
        </div>

        {workspaceId && (
          <div className="ai-workspace-info">
            Workspace: {workspaceId}
          </div>
        )}
      </header>

      <AIToolbar
        activeAction={activeAction}
        onAction={setActiveAction}
        disabled={loading}
      />

      <AIChat
        activeAction={activeAction}
        onSubmit={handleSubmit}
        loading={loading}
        messages={messages}
      />
    </main>
  );
}