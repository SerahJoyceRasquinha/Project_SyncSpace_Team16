import { SERVER_URL } from "./socket";

/**
 * One fetch wrapper for the whole app.
 * The backend always answers errors as { error: "human readable" }, so this
 * surfaces that string and never leaks a stack trace or a status code at the user.
 */
async function request(path, { method = "GET", body, token, timeoutMs = 20000, signal } = {}) {
  // Every request carries a deadline. Without one, a backend that accepts the
  // connection and then stalls leaves the caller awaiting forever - which in
  // the IDE looked like a Run button stuck on "Running..." with no way out.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);

  let res;
  try {
    res = await fetch(`${SERVER_URL}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        signal?.aborted
          ? "Cancelled."
          : "The server took too long to answer. It may be busy - try again in a moment."
      );
    }
    // fetch itself failed -> the server is down or the network dropped
    throw new Error("Cannot reach the server. Is the backend running?");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

export const api = {
  createWorkspace: (body) => request("/workspaces", { method: "POST", body }),

  joinWorkspace: (workspaceId, body) =>
    request(`/workspaces/${workspaceId}/join`, { method: "POST", body }),

  me: (workspaceId, token) => request(`/workspaces/${workspaceId}/me`, { token }),

  setPolicy: (workspaceId, token, permissionMode) =>
    request(`/workspaces/${workspaceId}/policy`, {
      method: "PATCH",
      token,
      body: { permissionMode }
    }),

  /**
   * Languages the execution service offers (drives the IDE dropdown).
   * Each entry carries `available` + `missing`, so the dropdown can grey out
   * anything whose compiler is not installed instead of failing on Run.
   */
  languages: (workspaceId, token, { refresh = false } = {}) =>
    request(
      `/workspaces/${workspaceId}/execute/languages${refresh ? "?refresh=1" : ""}`,
      { token, timeoutMs: 10000 }
    ),

  /**
   * Run code on the server. Resolves { result } - see services/execution.
   * The generous deadline covers the worst legitimate case: queue wait (20s)
   * + compile (20s) + run (5s), plus slack. Anything past that is a hang.
   */
  execute: (workspaceId, token, body, { signal } = {}) =>
    request(`/workspaces/${workspaceId}/execute`, {
      method: "POST",
      token,
      body,
      timeoutMs: 60000,
      signal
    })
};
