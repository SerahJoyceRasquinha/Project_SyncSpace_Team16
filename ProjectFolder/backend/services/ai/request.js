/**
 * The planner: turns a validated HTTP body into everything the provider call
 * needs, and decides — before any network I/O — whether a model call is even
 * warranted.
 *
 * Splitting this out of aiService.js is what makes the module testable. The
 * plan is a plain object, so every language decision, every prompt, and every
 * model choice can be asserted in test-ai.mjs without a provider, a key, or a
 * millisecond of latency.
 *
 * It is also where the old `buildUserPrompt` died. That function emitted every
 * field it had, unconditionally, under generic headers:
 *
 *     ACTION: generate
 *     USER REQUEST: give me the hello world program in java
 *     PROGRAMMING LANGUAGE: javascript      <- contradicts the line above
 *
 * Two authoritative-looking statements, no resolution, no priority. The model
 * picked the structured one. Now the language is settled first, the winner goes
 * into the SYSTEM turn, and the user turn carries only fields the action
 * actually uses.
 */
import {
  resolveLanguage,
  resolveConversion,
  labelOf,
  fenceOf
} from './languages.js';
import { buildSystemInstruction } from './prompts.js';

/** Which fields each action is allowed to send. Anything else is noise. */
const RELEVANT_FIELDS = {
  chat:     ['message', 'code'],
  generate: ['message'],
  explain:  ['code', 'message'],
  error:    ['error', 'code', 'message'],
  debug:    ['code', 'error', 'message'],
  tests:    ['code', 'message'],
  optimize: ['code', 'message'],
  convert:  ['code', 'message'],
  document: ['code', 'message']
};

/** Actions that cannot do anything useful without code attached. */
const NEEDS_CODE = new Set(['explain', 'debug', 'tests', 'optimize', 'convert', 'document']);

/** The user asking, in their own words, for more than the default terseness. */
const DETAIL_RE = /\b(explain|in detail|detailed|step[- ]by[- ]step|walk me through|why does|how does|elaborate|thorough|comment(ed)?|with comments|teach)\b/i;

/**
 * How hard is this request, really?
 *
 * This drives BOTH the model tier and the thinking level, so it is the main
 * lever on latency. Getting it wrong in the cheap direction costs quality on
 * hard problems; getting it wrong in the expensive direction costs a user
 * staring at a spinner while a model reasons about `System.out.println`.
 */
export function classifyComplexity({ action, message = '', code = '', error = '' }) {
  const totalChars = message.length + code.length + error.length;

  // Anything reasoning-shaped starts at least one tier up: these are the
  // actions where a wrong-but-fast answer wastes more time than it saves.
  const DEEP_ACTIONS = new Set(['debug', 'error', 'optimize']);

  if (DEEP_ACTIONS.has(action)) {
    return totalChars > 1200 ? 'deep' : 'standard';
  }

  if (action === 'convert' || action === 'explain' || action === 'tests') {
    return totalChars > 2500 ? 'deep' : 'standard';
  }

  // Textbook one-liners: hello world, fizzbuzz, a loop, a single function.
  const TRIVIAL_RE = /\b(hello,? world|hello world program|fizz ?buzz|swap two|print (a|the) )\b/i;
  if ((action === 'generate' || action === 'chat') && totalChars < 220) {
    if (TRIVIAL_RE.test(message) || totalChars < 80) return 'simple';
    return 'simple';
  }

  if (totalChars > 3000) return 'deep';
  return 'standard';
}

/**
 * Cap output length by intent. A Hello World that is allowed 8k tokens can
 * still ramble into 8k tokens; a ceiling is a latency guarantee, not just a
 * cost control. Generous enough that legitimate answers are never truncated.
 */
function maxOutputTokensFor(action, complexity, detailRequested) {
  if (detailRequested) return 4096;
  if (complexity === 'simple') return 1024;
  if (complexity === 'deep') return 6144;
  return 3072;
}

function section(title, value) {
  return `${title}:\n${value}`;
}

/**
 * Build the user turn: only the fields this action uses, each clearly labelled,
 * code always fenced so the model never confuses it with instructions.
 */
function buildUserContent({ action, message, code, error, language, editorContext }) {
  const allowed = RELEVANT_FIELDS[action] || RELEVANT_FIELDS.chat;
  const parts = [];

  if (allowed.includes('message') && message) {
    parts.push(section('REQUEST', message));
  }

  if (allowed.includes('error') && error) {
    parts.push(section('ERROR OUTPUT', '```\n' + error + '\n```'));
  }

  if (allowed.includes('code') && code) {
    const fence = language ? fenceOf(language) : '';
    parts.push(section('CODE', '```' + fence + '\n' + code + '\n```'));
  }

  // Editor context is included ONLY when it adds something the fields above do
  // not already carry. Sending the whole buffer on every chat message was never
  // free: it is input tokens, prompt-build time, and a distraction for the model.
  if (editorContext?.filename) {
    parts.push(section('FILE', editorContext.filename));
  }

  if (parts.length === 0) {
    parts.push('No request content was supplied.');
  }

  return parts.join('\n\n');
}

/**
 * Plan a request.
 *
 * Returns either:
 *   { kind: 'clarify', answer }  — answered locally, zero provider latency
 *   { kind: 'model', ... }       — ready to send
 */
export function planRequest(data) {
  const {
    action = 'chat',
    message = '',
    code = '',
    error = '',
    language: requestLanguage = '',
    targetLanguage: requestTarget = '',
    editorContext = null
  } = data;

  // ---- guard rails that need no model --------------------------------------
  if (!message.trim() && !code.trim() && !error.trim()) {
    return {
      kind: 'clarify',
      reason: 'empty-request',
      answer: 'I did not receive anything to work on. Type a question, or paste the code or error you want me to look at.'
    };
  }

  if (NEEDS_CODE.has(action) && !code.trim() && !message.trim()) {
    return {
      kind: 'clarify',
      reason: 'missing-code',
      answer: `Paste the code you want me to ${action === 'tests' ? 'write tests for' : action}, and I'll take a look.`
    };
  }

  const detailRequested = DETAIL_RE.test(message);

  // ---- language: settled once, here ----------------------------------------
  let language = null;
  let targetLanguage = null;
  let languageDecision;

  if (action === 'convert') {
    const conversion = resolveConversion({
      message,
      code,
      requestLanguage,
      targetLanguage: requestTarget
    });

    if (conversion.needsClarification) {
      return { kind: 'clarify', reason: 'ambiguous-conversion', answer: conversion.question };
    }

    language = conversion.from;
    targetLanguage = conversion.to;
    languageDecision = {
      language,
      targetLanguage,
      source: conversion.fromSource,
      targetSource: conversion.toSource
    };
  } else {
    const resolved = resolveLanguage({ message, code, requestLanguage, action });

    if (resolved.needsClarification) {
      return {
        kind: 'clarify',
        reason: 'ambiguous-language',
        answer: 'Which language should I write this in? (For example: Java, Python, C, C++, JavaScript.)'
      };
    }

    language = resolved.language;
    languageDecision = resolved;
  }

  const complexity = classifyComplexity({ action, message, code, error });

  const systemInstruction = buildSystemInstruction({
    action,
    language,
    targetLanguage,
    complexity,
    detailRequested
  });

  const userContent = buildUserContent({
    action,
    message,
    code,
    error,
    // The fence on the CODE block should describe the SOURCE for a conversion.
    language,
    editorContext
  });

  return {
    kind: 'model',
    action,
    language,
    targetLanguage,
    languageDecision,
    complexity,
    detailRequested,
    systemInstruction,
    userContent,
    maxOutputTokens: maxOutputTokensFor(action, complexity, detailRequested),
    /** Diagnostics the route echoes to the client as stream metadata. */
    meta: {
      action,
      language,
      languageLabel: language ? labelOf(language) : null,
      targetLanguage,
      targetLanguageLabel: targetLanguage ? labelOf(targetLanguage) : null,
      languageSource: languageDecision?.source || 'none',
      complexity
    }
  };
}
