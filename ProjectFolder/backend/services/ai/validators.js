const MAX_MESSAGE_LENGTH = 8000;
const MAX_CODE_LENGTH = 30000;
const MAX_ERROR_LENGTH = 8000;

const ALLOWED_ACTIONS = new Set([
  "chat",
  "explain",
  "generate",
  "error",
  "debug",
  "tests",
  "optimize",
  "convert",
  "document"
]);

export function validateAIRequest(body = {}) {
  const {
    action = "chat",
    message = "",
    code = "",
    error = "",
    language = "",
    targetLanguage = ""
  } = body;

  if (!ALLOWED_ACTIONS.has(action)) {
    return {
      valid: false,
      error: "Invalid AI action."
    };
  }

  if (typeof message !== "string") {
    return {
      valid: false,
      error: "Message must be a string."
    };
  }

  if (typeof code !== "string") {
    return {
      valid: false,
      error: "Code must be a string."
    };
  }

  if (typeof error !== "string") {
    return {
      valid: false,
      error: "Error must be a string."
    };
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      valid: false,
      error: `Message is too long. Maximum ${MAX_MESSAGE_LENGTH} characters.`
    };
  }

  if (code.length > MAX_CODE_LENGTH) {
    return {
      valid: false,
      error: `Code is too long. Maximum ${MAX_CODE_LENGTH} characters.`
    };
  }

  if (error.length > MAX_ERROR_LENGTH) {
    return {
      valid: false,
      error: `Error message is too long. Maximum ${MAX_ERROR_LENGTH} characters.`
    };
  }

  return {
    valid: true,
    data: {
      action,
      message: message.trim(),
      code,
      error,
      language: typeof language === "string" ? language.trim() : "",
      targetLanguage:
        typeof targetLanguage === "string"
          ? targetLanguage.trim()
          : ""
    }
  };
}