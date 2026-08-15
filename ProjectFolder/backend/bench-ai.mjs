/**
 * Real-provider latency benchmark.
 *
 *   node bench-ai.mjs
 *
 * This is the one measurement I could not take for you: the sandbox this was
 * built in cannot reach generativelanguage.googleapis.com, so every "before"
 * number in the write-up came from a local mock that reproduces the SHAPE of
 * the problem (buffered call + default thinking level) rather than Google's
 * actual wall-clock. Run this on your machine, with your key, to get the real
 * figures for your report.
 *
 * It measures four configurations against the same prompt, in order of how
 * SyncSpace evolved:
 *
 *   A  buffered  + gemini-3.6-flash + default thinking   <- what shipped
 *   B  buffered  + gemini-3.6-flash + thinking: low
 *   C  streaming + gemini-3.6-flash + thinking: low      <- the smart tier
 *   D  streaming + flash-lite       + thinking: minimal  <- the fast tier
 *
 * and reports, for each: time to FIRST visible character, and total time.
 * The first number is the one users experience as "speed".
 *
 * Requires only GEMINI_API_KEY in backend/.env.
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { planRequest } from './services/ai/request.js';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('\n  GEMINI_API_KEY is not set. Add it to backend/.env first.\n');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: KEY, httpOptions: { timeout: 120_000 } });

const RUNS = Number(process.env.BENCH_RUNS) || 3;

/** The exact request from the bug report. */
const PLAN = planRequest({
  action: 'generate',
  message: 'give me the hello world program in java',
  language: 'javascript'
});

/** The prompt the OLD code would have sent, verbatim, for a fair comparison. */
const OLD_PROMPT = `
ACTION:
generate

USER REQUEST:
give me the hello world program in java

PROGRAMMING LANGUAGE:
javascript
`;

const OLD_SYSTEM = `
You are SyncSpace AI, a senior software engineer.

Generate clean, maintainable code based on the user's requirements.

Rules:
- Follow the requested programming language.
- Prefer readable and practical code.
- Include necessary imports.
- Avoid unnecessary dependencies.
- Explain important implementation decisions briefly.
`;

async function buffered({ model, thinkingLevel, system, contents, maxOutputTokens }) {
  const t0 = performance.now();
  const config = { systemInstruction: system };
  if (thinkingLevel) config.thinkingConfig = { thinkingLevel };
  if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;

  const response = await ai.models.generateContent({ model, contents, config });
  const total = performance.now() - t0;
  return { first: total, total, text: response.text || '' };
}

async function streamed({ model, thinkingLevel, system, contents, maxOutputTokens }) {
  const t0 = performance.now();
  const config = { systemInstruction: system };
  if (thinkingLevel) config.thinkingConfig = { thinkingLevel };
  if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;

  const stream = await ai.models.generateContentStream({ model, contents, config });

  let first = null;
  let text = '';
  for await (const chunk of stream) {
    const parts = chunk?.candidates?.[0]?.content?.parts || [];
    let piece = '';
    for (const part of parts) {
      if (part?.thought) continue;
      if (typeof part?.text === 'string') piece += part.text;
    }
    if (!piece) continue;
    if (first === null) first = performance.now() - t0;
    text += piece;
  }
  return { first: first ?? performance.now() - t0, total: performance.now() - t0, text };
}

const CONFIGS = [
  {
    id: 'A', label: 'buffered + 3.6-flash + DEFAULT thinking  (as shipped)',
    run: buffered,
    args: { model: 'gemini-3.6-flash', thinkingLevel: null, system: OLD_SYSTEM, contents: OLD_PROMPT }
  },
  {
    id: 'B', label: 'buffered + 3.6-flash + thinking: low',
    run: buffered,
    args: { model: 'gemini-3.6-flash', thinkingLevel: 'low', system: PLAN.systemInstruction, contents: PLAN.userContent, maxOutputTokens: PLAN.maxOutputTokens }
  },
  {
    id: 'C', label: 'STREAMED + 3.6-flash + thinking: low     (smart tier)',
    run: streamed,
    args: { model: process.env.AI_MODEL_SMART || 'gemini-3.6-flash', thinkingLevel: 'low', system: PLAN.systemInstruction, contents: PLAN.userContent, maxOutputTokens: PLAN.maxOutputTokens }
  },
  {
    id: 'D', label: 'STREAMED + flash-lite + thinking: minimal (fast tier)',
    run: streamed,
    args: { model: process.env.AI_MODEL_FAST || 'gemini-3.5-flash-lite', thinkingLevel: 'minimal', system: PLAN.systemInstruction, contents: PLAN.userContent, maxOutputTokens: PLAN.maxOutputTokens }
  }
];

console.log(`\n  SyncSpace AI — latency benchmark  (${RUNS} runs each)`);
console.log(`  Prompt: "give me the hello world program in java"\n`);
console.log('  ' + '-'.repeat(78));
console.log('  ' + 'configuration'.padEnd(54) + 'first text'.padStart(12) + 'total'.padStart(12));
console.log('  ' + '-'.repeat(78));

const results = [];

for (const config of CONFIGS) {
  const firsts = [];
  const totals = [];
  let sample = '';
  let failed = null;

  for (let i = 0; i < RUNS; i++) {
    try {
      const r = await config.run(config.args);
      firsts.push(r.first);
      totals.push(r.total);
      sample = r.text;
    } catch (error) {
      failed = error?.message || String(error);
      break;
    }
  }

  if (failed) {
    console.log('  ' + config.label.padEnd(54) + '  FAILED: ' + failed.slice(0, 60));
    continue;
  }

  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const first = median(firsts);
  const total = median(totals);
  results.push({ id: config.id, label: config.label, first, total, sample });

  console.log(
    '  ' + config.label.padEnd(54) +
    `${first.toFixed(0)} ms`.padStart(12) +
    `${total.toFixed(0)} ms`.padStart(12)
  );
}

console.log('  ' + '-'.repeat(78));

const before = results.find((r) => r.id === 'A');
const after = results.find((r) => r.id === 'D');

if (before && after) {
  console.log(`\n  Time to first visible character: ${before.first.toFixed(0)} ms -> ${after.first.toFixed(0)} ms  ` +
    `(${(before.first / after.first).toFixed(1)}x faster)`);
  console.log(`  Total response time:             ${before.total.toFixed(0)} ms -> ${after.total.toFixed(0)} ms  ` +
    `(${(before.total / after.total).toFixed(1)}x faster)`);
}

// ---- the correctness half of the benchmark --------------------------------
console.log('\n  Language check (the reported bug):\n');
for (const r of results) {
  const isJava = /class\s+\w+|System\.out\.println/.test(r.sample);
  const isJs = /console\.log/.test(r.sample);
  const verdict = isJava && !isJs ? 'JAVA   ok' : isJs ? 'JAVASCRIPT  <-- WRONG' : 'unclear';
  console.log(`    ${r.id}  ${verdict}`);
}

console.log(`\n  Sample answer from the fast tier:\n`);
console.log((after?.sample || '(none)').split('\n').map((l) => '    | ' + l).join('\n'));
console.log('');
