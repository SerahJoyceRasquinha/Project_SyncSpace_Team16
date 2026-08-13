import { SERVER_URL } from "../utils/socket";

async function sendAIRequest({
  action,
  message = "",
  code = "",
  error = "",
  language = "",
  targetLanguage = "",
  token
}) {
  const response = await fetch(`${SERVER_URL}/api/ai`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      action,
      message,
      code,
      error,
      language,
      targetLanguage
    })
  });

  let data = {};

  try {
    data = await response.json();
  } catch {
    throw new Error("The AI server returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(
      data.error || "The AI request failed. Please try again."
    );
  }

  return data;
}

export const aiApi = {
  chat: (message, options = {}) =>
    sendAIRequest({
      action: "chat",
      message,
      token: options.token
    }),

  explain: (code, language, options = {}) =>
    sendAIRequest({
      action: "explain",
      code,
      language,
      message: options.message || "",
      token: options.token
    }),

  generate: (message, language, options = {}) =>
    sendAIRequest({
      action: "generate",
      message,
      language,
      token: options.token
    }),

  analyzeError: (error, code = "", language = "", options = {}) =>
    sendAIRequest({
      action: "error",
      error,
      code,
      language,
      token: options.token
    }),

  debug: (code, error, language, options = {}) =>
    sendAIRequest({
      action: "debug",
      code,
      error,
      language,
      token: options.token
    }),

  generateTests: (code, language, options = {}) =>
    sendAIRequest({
      action: "tests",
      code,
      language,
      token: options.token
    }),

  optimize: (code, language, options = {}) =>
    sendAIRequest({
      action: "optimize",
      code,
      language,
      token: options.token
    }),

  convert: (code, language, targetLanguage, options = {}) =>
    sendAIRequest({
      action: "convert",
      code,
      language,
      targetLanguage,
      token: options.token
    }),

  document: (code, language, options = {}) =>
    sendAIRequest({
      action: "document",
      code,
      language,
      token: options.token
    })
};