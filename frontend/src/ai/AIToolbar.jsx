const ACTIONS = [
  {
    id: "chat",
    label: "Chat"
  },
  {
    id: "explain",
    label: "Explain Code"
  },
  {
    id: "generate",
    label: "Generate Code"
  },
  {
    id: "error",
    label: "Analyze Error"
  },
  {
    id: "debug",
    label: "Debug"
  },
  {
    id: "tests",
    label: "Generate Tests"
  },
  {
    id: "optimize",
    label: "Optimize"
  },
  {
    id: "convert",
    label: "Convert"
  },
  {
    id: "document",
    label: "Documentation"
  }
];

export default function AIToolbar({
  activeAction,
  onAction,
  disabled = false
}) {
  return (
    <div className="ai-toolbar">
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className={
            activeAction === action.id
              ? "ai-tool active"
              : "ai-tool"
          }
          onClick={() => onAction(action.id)}
          disabled={disabled}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}