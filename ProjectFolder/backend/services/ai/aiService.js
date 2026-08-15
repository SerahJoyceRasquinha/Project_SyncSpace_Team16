/**
 * The Gemini provider adapter.
 *
 * WHY THIS WAS SLOW
 * -----------------
 * The previous version was four lines of SDK call with two latency defects
 * that compounded:
 *
 *   1. `generateContent` — the BUFFERED endpoint. The backend awaited the
 *      entire completion, then Express serialised it, then React rendered it.
 *      Time to first visible character == time to LAST generated token. A
 *      600-token answer at ~200 tok/s is 3 s of generation that the user spends
 *      looking at a "Working..." button, on top of everything below.
 *
 *   2. No `thinkingConfig`. gemini-3.6-flash defaults to thinking level
 *      `medium`, and 3.7-flash likewise. Those are *reasoning* models: before
 *      emitting a single visible token they generate hidden thought tokens,
 *      billed as output and paid for in wall-clock time. On a request as
 *      trivial as "hello world in java" the model still deliberates. Combined
 *      with (1) — thinking time + full generation time, serialised, with
 *      nothing shown until both finish — that is the 1–2 minutes reported.
 *
 * Both are fixed here: streaming by default, and an explicit thinking level
 * chosen per request rather than inherited from the provider's default.
 *
 * MODEL TIERING
 * -------------
 * One model for every action was always the wrong shape. "Explain this stack
 * trace" and "hello world in java" do not deserve the same reasoning budget.
 * Two tiers, both overridable by environment:
 *
 *   FAST  gemini-3.5-flash-lite   thinking: minimal
 *         Google's low-latency tier (~350 output tok/s), and per Google's own
 *         launch numbers it beats the larger 3 Flash on SWE-Bench Pro — so this
 *         is not a quality sacrifice for ordinary coding work. Handles chat,
 *         generate, document, tests.
 *
 *   SMART gemini-3.6-flash        thinking: low
 *         Reserved for the actions where being wrong costs more than being
 *         slow: debug, error analysis, optimisation, conversion, and anything
 *         with a large payload. `low` rather than the default `medium` because
 *         this is an interactive assistant, not a batch agent.
 *
 * Sampling parameters (temperature / top_p / top_k) are deliberately NOT sent:
 * Google deprecated them for Gemini 3.x and they are ignored by the route.
 * Output shape is controlled through the system instruction and thinking level
 * instead — see prompts.js.
 */
import { GoogleGenAI } from '@google/genai';

const DEFAULT_FAST_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_SMART_MODEL = 'gemini-3.6-flash';

/** Wall-clock ceiling for a whole generation. */
const REQUEST_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60_000;
/** If the provider goes quiet mid-stream for this long, we give up on it. */
const STALL_TIMEOUT_MS = Number(process.env.AI_STALL_TIMEOUT_MS) || 20_000;

/**
 * One client for the process.
 *
 * Not a micro-optimisation: the SDK holds the underlying HTTP agent, so a
 * per-request client would mean a fresh TLS handshake to Google on every
 * keystroke-sized request. Reused, the connection stays warm.
 */
let client = null;
let clientKey = null;

export function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // Rebuild if the key changed (tests swap it; nodemon reloads it).
  if (client && clientKey === apiKey) return client;

  const httpOptions = { timeout: REQUEST_TIMEOUT_MS };

  // Test hook: lets the suite point the SDK at a local mock of Google's API.
  if (process.env.GEMINI_BASE_URL) {
    httpOptions.baseUrl = process.env.GEMINI_BASE_URL;
  }

  client = new GoogleGenAI({ apiKey, httpOptions });
  clientKey = apiKey;
  return client;
}

/** Test/reload hook. */
export function resetClient() {
  client = null;
  clientKey = null;
}

/** Which tier an action lands in, before payload size is considered. */
const SMART_ACTIONS = new Set(['debug', 'error', 'optimize', 'convert']);

export function selectModel({ action, complexity, payloadChars = 0 }) {
  const fast = process.env.AI_MODEL_FAST || DEFAULT_FAST_MODEL;
  const smart = process.env.AI_MODEL_SMART || DEFAULT_SMART_MODEL;

  // A single override still wins, so an operator can pin one model everywhere.
  if (process.env.GEMINI_MODEL) {
    return { model: process.env.GEMINI_MODEL, tier: 'pinned' };
  }

  if (complexity === 'deep' || SMART_ACTIONS.has(action) || payloadChars > 4000) {
    return { model: smart, tier: 'smart' };
  }
  return { model: fast, tier: 'fast' };
}

/**
 * Thinking level per tier. This is the single biggest latency lever available.
 *
 * `minimal` is not supported by every model (3.7 Flash accepts only
 * low/medium/high), so the floor is raised for models that reject it.
 */
export function selectThinkingLevel({ model, tier, complexity }) {
  const override = tier === 'fast'
    ? process.env.AI_THINKING_FAST
    : process.env.AI_THINKING_SMART;
  if (override) return override.toLowerCase();

  const supportsMinimal = !/gemini-3\.7/i.test(model);

  if (complexity === 'deep') return 'medium';
  if (tier === 'smart') return 'low';
  return supportsMinimal ? 'minimal' : 'low';
}

/**
 * Turn a provider exception into something safe to show a user.
 *
 * The old handler returned `error.message` straight through to the browser.
 * Google's messages can contain the request URL, the model path, and quota
 * identifiers — backend detail that has no business in a chat bubble. Each
 * case below is matched on shape, logged in full server-side, and reported as
 * a sentence that tells the user what to actually do.
 */
export function describeProviderError(error) {
  const status = error?.status ?? error?.code ?? error?.response?.status;
  const raw = String(error?.message || '');

  if (error?.name === 'AbortError' || /abort/i.test(raw)) {
    return { code: 'cancelled', status: 499, message: 'Request cancelled.' };
  }
  if (status === 400 && /api[_ ]?key/i.test(raw)) {
    return { code: 'bad-key', status: 502, message: 'The AI service rejected the configured API key. Check GEMINI_API_KEY on the server.' };
  }
  if (status === 401 || status === 403) {
    return { code: 'forbidden', status: 502, message: 'The AI service refused the request. The API key may lack access to this model.' };
  }
  if (status === 404) {
    return { code: 'bad-model', status: 502, message: 'The configured AI model does not exist. Check GEMINI_MODEL / AI_MODEL_FAST / AI_MODEL_SMART on the server.' };
  }
  if (status === 429) {
    return { code: 'rate-limited', status: 429, message: 'The AI service is rate limiting requests. Wait a few seconds and try again.' };
  }
  if (status === 503 || status === 500 || status === 502) {
    return { code: 'provider-down', status: 503, message: 'The AI service is temporarily unavailable. Please try again in a moment.' };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i.test(raw)) {
    return { code: 'network', status: 504, message: 'Could not reach the AI service. Check the server\'s network connection and try again.' };
  }
  return { code: 'provider-error', status: 502, message: 'The AI service could not complete this request. Please try again.' };
}

const NO_KEY_MESSAGE =
  'SyncSpace AI is not configured on this server: no GEMINI_API_KEY is set. ' +
  'Add a key to backend/.env and restart the backend.';

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Stream one request.
 *
 * An async generator rather than a callback so the route stays a plain loop and
 * back-pressure works: if the browser stops reading, `res.write` returns false,
 * the loop awaits drain, and we stop pulling from Google. Yields:
 *
 *   { type: 'meta',  ... }  once, immediately, before the provider is called
 *   { type: 'delta', text } zero or more
 *   { type: 'done',  ... }  once, on success
 *   { type: 'error', ... }  once, on failure (never throws at the caller)
 */
export async function* streamAI(plan, { signal } = {}) {
  const payloadChars = plan.systemInstruction.length + plan.userContent.length;
  const { model, tier } = selectModel({
    action: plan.action,
    complexity: plan.complexity,
    payloadChars
  });
  const thinkingLevel = selectThinkingLevel({ model, tier, complexity: plan.complexity });

  yield {
    type: 'meta',
    ...plan.meta,
    model,
    tier,
    thinkingLevel,
    promptChars: payloadChars
  };

  const gemini = getClient();
  if (!gemini) {
    yield { type: 'error', code: 'not-configured', message: NO_KEY_MESSAGE };
    return;
  }

  // Our own deadline, on top of the SDK's: the SDK timeout covers the request,
  // this covers a provider that accepts the connection and then dribbles.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  const hardStop = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  const startedAt = Date.now();
  let firstTokenAt = null;
  let charCount = 0;

  try {
    armStall();

    const stream = await gemini.models.generateContentStream({
      model,
      contents: plan.userContent,
      config: {
        systemInstruction: plan.systemInstruction,
        maxOutputTokens: plan.maxOutputTokens,
        thinkingConfig: { thinkingLevel },
        abortSignal: controller.signal
        // NO temperature / topP / topK: deprecated for Gemini 3.x.
      }
    });

    for await (const chunk of stream) {
      armStall();

      // A chunk can carry thought parts as well as answer parts. We never
      // requested thoughts (includeThoughts defaults false), but guard anyway:
      // rendering a model's private reasoning as the answer would be a bug.
      const parts = chunk?.candidates?.[0]?.content?.parts || [];
      let text = '';
      for (const part of parts) {
        if (part?.thought) continue;
        if (typeof part?.text === 'string') text += part.text;
      }

      if (!text) continue;

      if (firstTokenAt === null) firstTokenAt = Date.now();
      charCount += text.length;
      yield { type: 'delta', text };
    }

    if (charCount === 0) {
      yield {
        type: 'error',
        code: 'empty-response',
        message: 'The AI service returned an empty response. Try rephrasing the request.'
      };
      return;
    }

    yield {
      type: 'done',
      model,
      tier,
      thinkingLevel,
      chars: charCount,
      timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
      totalMs: Date.now() - startedAt
    };
  } catch (error) {
    // Distinguish "the client hung up" from "the provider failed".
    if (signal?.aborted) {
      yield { type: 'error', code: 'cancelled', message: 'Request cancelled.' };
      return;
    }

    const timedOut = controller.signal.aborted;
    // Full detail server-side only.
    console.error('[ai] provider error:', error?.status || '', error?.message || error);

    if (timedOut) {
      yield {
        type: 'error',
        code: 'timeout',
        message: charCount > 0
          ? 'The AI service stopped responding partway through. The partial answer above is all that arrived.'
          : 'The AI service took too long to respond. Please try again.',
        partial: charCount > 0
      };
      return;
    }

    const described = describeProviderError(error);
    yield { type: 'error', ...described, partial: charCount > 0 };
  } finally {
    clearTimeout(hardStop);
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Non-streaming path, for clients that cannot read a stream.
 *
 * Implemented ON TOP of the streaming call rather than as a second SDK call, so
 * there is exactly one place where a request is built, one place where errors
 * are classified, and no chance of the two paths drifting apart. It costs
 * nothing extra: the provider streams either way.
 */
export async function runAI(plan, { signal } = {}) {
  let answer = '';
  let meta = null;
  let done = null;

  for await (const event of streamAI(plan, { signal })) {
    if (event.type === 'meta') meta = event;
    else if (event.type === 'delta') answer += event.text;
    else if (event.type === 'done') done = event;
    else if (event.type === 'error') {
      return {
        success: false,
        provider: 'gemini',
        code: event.code,
        error: event.message,
        answer: answer || '',
        meta
      };
    }
  }

  return {
    success: true,
    provider: 'gemini',
    answer,
    meta: { ...meta, ...done }
  };
}
