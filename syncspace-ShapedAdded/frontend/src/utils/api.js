import { SERVER_URL } from "./socket";

/**
 * One fetch wrapper for the whole app.
 * The backend always answers errors as { error: "human readable" }, so this
 * surfaces that string and never leaks a stack trace or a status code at the user.
 */
async function request(path, { method = "GET", body, token } = {}) {
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    // fetch itself failed -> the server is down or the network dropped
    throw new Error("Cannot reach the server. Is the backend running?");
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

  /** Languages the execution service offers (drives the IDE dropdown). */
  languages: (workspaceId, token) =>
    request(`/workspaces/${workspaceId}/execute/languages`, { token }),

  /** Run code on the server. Resolves { result } — see services/execution. */
  execute: (workspaceId, token, body) =>
    request(`/workspaces/${workspaceId}/execute`, { method: "POST", token, body })
};
