import { GoogleGenAI } from "@google/genai";
import { getPrompt } from "./prompts.js";

let client = null;

function getClient() {
  if (client) {
    return client;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return null;
  }

  client = new GoogleGenAI({
    apiKey,
  });

  return client;
}

function buildUserPrompt(data) {
  const {
    action,
    message,
    code,
    error,
    language,
    targetLanguage,
  } = data;

  const sections = [];

  if (message) {
    sections.push(`USER REQUEST:\n${message}`);
  }

  if (language) {
    sections.push(`PROGRAMMING LANGUAGE:\n${language}`);
  }

  if (targetLanguage) {
    sections.push(`TARGET LANGUAGE:\n${targetLanguage}`);
  }

  if (code) {
    sections.push(`CODE:\n${code}`);
  }

  if (error) {
    sections.push(`ERROR:\n${error}`);
  }

  if (sections.length === 0) {
    sections.push("No additional user context was provided.");
  }

  return `
ACTION:
${action}

${sections.join("\n\n")}
`;
}

export async function runAI(data) {
  const gemini = getClient();

  /*
   * During initial development, allow the API
   * to work without a Gemini API key.
   */
  if (!gemini) {
    return {
      success: true,
      provider: "mock",
      answer:
        "SyncSpace AI backend is working, but no GEMINI_API_KEY is configured yet.",
    };
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  try {
    const response = await gemini.models.generateContent({
      model,
      contents: buildUserPrompt(data),
      config: {
        systemInstruction: getPrompt(data.action),
      },
    });

    return {
      success: true,
      provider: "gemini",
      answer:
        response.text || "Gemini returned an empty response.",
    };
  } catch (error) {
    console.error("Gemini API Error:", error);

    return {
      success: false,
      provider: "gemini",
      answer: "Gemini failed to generate a response.",
      error: error.message,
    };
  }
}