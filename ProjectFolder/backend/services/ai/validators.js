/**
 * Everything arriving from a browser passes through here before it reaches the
 * planner, and nothing downstream re-checks types. Same contract as
 * utils/validate.js elsewhere in the project: return a reason, never throw.
 *
 * The caps are latency controls as much as safety controls. A 30 000-character
 * code blob is ~8 000 input tokens; the model reads all of it before emitting
 * anything, so an unbounded payload is an unbounded wait. Express already caps
 * the whole body at 1 MB in server.js — these are the per-field limits inside
 * that.
 */
import { SUPPORTED_ACTIONS } from './prompts.js';
import { normalizeLanguage, isSupportedLanguage } from './languages.js';

export const LIMITS = {
  message: 8_000,
  code: 30_000,
  error: 8_000,
  filename: 200,
  /** Belt-and-braces against a body that slips past the field caps. */
  total: 45_000
};

const ALLOWED_ACTIONS = new Set(SUPPORTED_ACTIONS);

const fail = (error, code = 'invalid-request') => ({ valid: false, error, code });

/**
 * Strip characters that corrupt an SSE frame or a prompt.
 *
 * Lone CR and the C0 range (except \t and \n) are removed: a stray \r inside a
 * code sample used to be echoed straight into the event stream, where it can
 * terminate a `data:` line early and desynchronise the client parser. Tabs and
 * newlines obviously stay — this is source code.
 */
function sanitizeText(value) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function validateAIRequest(body = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('The AI request body must be a JSON object.');
  }

  const {
    action = 'chat',
    message = '',
    code = '',
    error = '',
    language = '',
    targetLanguage = '',
    editorContext = null
  } = body;

  if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
    return fail(
      `Unsupported AI action. Supported actions: ${SUPPORTED_ACTIONS.join(', ')}.`,
      'invalid-action'
    );
  }

  for (const [name, value] of Object.entries({ message, code, error })) {
    if (typeof value !== 'string') {
      return fail(`The "${name}" field must be text.`);
    }
    if (value.length > LIMITS[name]) {
      return fail(
        `That ${name === 'code' ? 'code' : name} is too long (${value.length.toLocaleString()} characters). ` +
        `The limit is ${LIMITS[name].toLocaleString()}. Send the relevant part instead.`,
        'too-large'
      );
    }
  }

  if (message.length + code.length + error.length > LIMITS.total) {
    return fail('That request is too large to process. Send less code or a shorter message.', 'too-large');
  }

  // Unknown languages are not an error — they are just not authoritative. A
  // user asking about COBOL should get an answer, not a validation failure; the
  // language simply stops being a hard pin and the model infers from the words.
  const normalizedLanguage = normalizeLanguage(language);
  const normalizedTarget = normalizeLanguage(targetLanguage);

  if (language && typeof language !== 'string') return fail('The "language" field must be text.');
  if (targetLanguage && typeof targetLanguage !== 'string') return fail('The "targetLanguage" field must be text.');

  let context = null;
  if (editorContext && typeof editorContext === 'object' && !Array.isArray(editorContext)) {
    const filename = typeof editorContext.filename === 'string'
      ? sanitizeText(editorContext.filename).slice(0, LIMITS.filename)
      : '';
    if (filename) context = { filename };
  }

  return {
    valid: true,
    data: {
      action,
      message: sanitizeText(message).trim(),
      code: sanitizeText(code),
      error: sanitizeText(error),
      language: normalizedLanguage || '',
      targetLanguage: normalizedTarget || '',
      /** Kept for diagnostics: did the client send something we did not know? */
      unknownLanguage: Boolean(language && !normalizedLanguage),
      editorContext: context
    }
  };
}

export { isSupportedLanguage };
