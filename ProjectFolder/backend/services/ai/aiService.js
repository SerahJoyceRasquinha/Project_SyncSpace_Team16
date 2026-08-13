import OpenAI from "openai";
import { getPrompt } from "./prompts.js";

let client = null;

function getClient() {
  if (client) {
    return client;
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  client = new OpenAI({
    apiKey
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
    targetLanguage
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
  const openai = getClient();

  /*
   * During initial development, allow the API to be tested
   * without an API key.
   */
  if (!openai) {
    return {
      success: true,
      provider: "mock",
      answer:
        "SyncSpace AI backend is working, but no OPENAI_API_KEY is configured yet. The real AI provider will be connected in the next step."
    };
  }

  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const response = await openai.responses.create({
    model,
    instructions: getPrompt(data.action),
    input: buildUserPrompt(data)
  });

  return {
    success: true,
    provider: "openai",
    answer: response.output_text || "The AI returned an empty response."
  };
}