import { useEffect } from "react";

/** Transient success / error notifications. Auto-dismiss after 4 seconds. */
export function Toaster({ toasts, dismiss }) {
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, dismiss }) {
  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), 4000);
    return () => clearTimeout(id);
  }, [toast.id, dismiss]);

  return (
    <div className={"toast " + toast.kind} onClick={() => dismiss(toast.id)}>
      {toast.message}
    </div>
  );
}
