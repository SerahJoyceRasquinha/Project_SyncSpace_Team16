import { useState } from "react";
import AIMessage from "./AIMessage.jsx";

const LANGUAGES = [
  "JavaScript",
  "TypeScript",
  "Python",
  "Java",
  "C",
  "C++",
  "C#",
  "Go",
  "Rust",
  "PHP"
];

const TARGET_LANGUAGES = [
  "JavaScript",
  "TypeScript",
  "Python",
  "Java",
  "C",
  "C++",
  "C#",
  "Go",
  "Rust",
  "PHP"
];

const ACTION_CONFIG = {
  chat: {
    title: "AI Chat",
    description: "Ask SyncSpace AI a programming question.",
    inputLabel: "Your Question",
    placeholder: "Example: Explain how REST APIs work."
  },

  explain: {
    title: "Explain Code",
    description: "Understand what your code does and how it works.",
    inputLabel: "Code",
    placeholder: "Paste the code you want explained..."
  },

  generate: {
    title: "Generate Code",
    description: "Describe what you want to build and let AI generate the code.",
    inputLabel: "Requirement",
    placeholder: "Example: Create a JavaScript function to check whether a number is prime."
  },

  error: {
    title: "Analyze Error",
    description: "Understand an error message and find possible solutions.",
    inputLabel: "Error Message",
    placeholder: "Paste the error message here..."
  },

  debug: {
    title: "Debug Code",
    description: "Analyze your code and error together to find the root cause.",
    inputLabel: "Code",
    placeholder: "Paste the code containing the problem..."
  },

  tests: {
    title: "Generate Test Cases",
    description: "Generate normal, boundary, and edge-case tests.",
    inputLabel: "Code",
    placeholder: "Paste the function or program..."
  },

  optimize: {
    title: "Optimize Code",
    description: "Find performance, readability, and maintainability improvements.",
    inputLabel: "Code",
    placeholder: "Paste the code you want to optimize..."
  },

  convert: {
    title: "Convert Code",
    description: "Convert your code from one programming language to another.",
    inputLabel: "Code",
    placeholder: "Paste the code you want to convert..."
  },

  document: {
    title: "Generate Documentation",
    description: "Create clear documentation for your code.",
    inputLabel: "Code",
    placeholder: "Paste the code you want documented..."
  }
};

function getActionConfig(action) {
  return ACTION_CONFIG[action] || ACTION_CONFIG.chat;
}

export default function AIChat({
  activeAction,
  onSubmit,
  loading,
  messages
}) {
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState("JavaScript");
  const [targetLanguage, setTargetLanguage] = useState("Python");
  const [errorInput, setErrorInput] = useState("");

  const config = getActionConfig(activeAction);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (loading) {
      return;
    }

    const trimmedInput = input.trim();

    if (!trimmedInput) {
      return;
    }

    const formData = {
      input: trimmedInput,
      language,
      targetLanguage,
      error: errorInput.trim()
    };

    setInput("");
    setErrorInput("");

    await onSubmit(formData);
  };

  const showLanguage =
    activeAction !== "chat" &&
    activeAction !== "convert";

  const showTargetLanguage =
    activeAction === "convert";
    
const showErrorField =
    activeAction === "debug";

  return (
    <section className="ai-chat">
      <div className="ai-tool-description">
        <h2>{config.title}</h2>

        <p>{config.description}</p>
      </div>

      <div className="ai-messages">
        {messages.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty-icon">✦</div>

            <h2>{config.title}</h2>

            <p>{config.description}</p>
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
        <div className="ai-form-fields">
          {showLanguage && (
            <div className="ai-field">
              <label htmlFor="ai-language">
                Programming Language
              </label>

              <select
                id="ai-language"
                value={language}
                onChange={(event) =>
                  setLanguage(event.target.value)
                }
                disabled={loading}
              >
                {LANGUAGES.map((item) => (
                  <option
                    key={item}
                    value={item}
                  >
                    {item}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showTargetLanguage && (
            <>
              <div className="ai-field">
                <label htmlFor="ai-source-language">
                  Source Language
                </label>

                <select
                  id="ai-source-language"
                  value={language}
                  onChange={(event) =>
                    setLanguage(event.target.value)
                  }
                  disabled={loading}
                >
                  {LANGUAGES.map((item) => (
                    <option
                      key={item}
                      value={item}
                    >
                      {item}
                    </option>
                  ))}
                </select>
              </div>

              <div className="ai-field">
                <label htmlFor="ai-target-language">
                  Target Language
                </label>

                <select
                  id="ai-target-language"
                  value={targetLanguage}
                  onChange={(event) =>
                    setTargetLanguage(event.target.value)
                  }
                  disabled={loading}
                >
                  {TARGET_LANGUAGES.map((item) => (
                    <option
                      key={item}
                      value={item}
                    >
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {showErrorField && activeAction === "debug" && (
            <div className="ai-field">
              <label htmlFor="ai-error">
                Error Message
              </label>

              <textarea
                id="ai-error"
                value={errorInput}
                onChange={(event) =>
                  setErrorInput(event.target.value)
                }
                placeholder="Paste the error message..."
                rows={3}
                disabled={loading}
              />
            </div>
          )}

          {showErrorField && activeAction === "error" && (
            <div className="ai-field">
              <label htmlFor="ai-error">
                Error Message
              </label>

              <textarea
                id="ai-error"
                value={errorInput}
                onChange={(event) =>
                  setErrorInput(event.target.value)
                }
                placeholder="Paste the error message..."
                rows={3}
                disabled={loading}
              />
            </div>
          )}

          <div className="ai-field ai-main-field">
            <label htmlFor="ai-input">
              {config.inputLabel}
            </label>

            <textarea
              id="ai-input"
              value={input}
              onChange={(event) =>
                setInput(event.target.value)
              }
              placeholder={config.placeholder}
              rows={activeAction === "chat" ? 4 : 10}
              disabled={loading}
              maxLength={30000}
            />
          </div>
        </div>

        <div className="ai-submit-row">
          <span className="ai-character-count">
            {input.length}/30000
          </span>

          <button
            type="submit"
            disabled={!input.trim() || loading}
          >
            {loading ? "Working..." : "Send to AI"}
          </button>
        </div>
      </form>
    </section>
  );
}