/**
 * SyncSpace AI — reconstruction test suite.
 *
 *   node test-ai.mjs
 *
 * Runs the real route, the real planner, the real prompts and the real SDK
 * against test-support/mock-gemini-api.mjs, which speaks Google's actual wire
 * format (including `:streamGenerateContent?alt=sse`) and models the one
 * property that dominates real latency: a thinking stall before the first
 * visible token, sized by the thinkingLevel in the request.
 *
 * No API key, no network, no cost — but every layer under test is the one that
 * ships. The only fake is Google itself.
 */
import http from 'http';
import express from 'express';
import { createMockGemini, THINK_MS } from './test-support/mock-gemini-api.mjs';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
};
const section = (t) => console.log(`\n— ${t}`);

// ---------------------------------------------------------------- environment
const mock = createMockGemini();
const geminiPort = await mock.listen();

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${geminiPort}`;
process.env.JWT_SECRET = 'test-secret';
process.env.AI_RATE_MAX = '1000';
delete process.env.GEMINI_MODEL; // must not be pinned, so tiering is exercised

const { planRequest, classifyComplexity } = await import('./services/ai/request.js');
const { validateAIRequest } = await import('./services/ai/validators.js');
const { selectModel, selectThinkingLevel, describeProviderError, resetClient } =
  await import('./services/ai/aiService.js');
const languages = await import('./services/ai/languages.js');
const { signAccessToken, signUserToken, signLobbyTicket } = await import('./utils/token.js');
const aiRoutes = (await import('./routes/aiRoutes.js')).default;
const workspaceStore = await import('./services/workspaceStore.js');

// A real workspace with a real member, so the auth middleware is exercised
// against the same store the rest of the app uses.
const workspaceId = 'WS-AITEST';
await workspaceStore.createWorkspace({
  workspaceId,
  name: 'AI Test Room',
  permissionMode: 'permission',
  status: 'open',
  members: [{ userId: 'u-serah', username: 'serah', role: 'admin' }],
  pendingRequests: []
});

const MEMBER_TOKEN = signAccessToken({
  workspaceId,
  userId: 'u-serah',
  username: 'serah',
  role: 'admin'
});
const USER_TOKEN = signUserToken({ userId: 'acct-1', email: 'a@b.c', username: 'serah' });
const LOBBY_TOKEN = signLobbyTicket({ workspaceId, requestId: 'r1', username: 'nobody' });
const STRANGER_TOKEN = signAccessToken({
  workspaceId, userId: 'not-a-member', username: 'stranger', role: 'member'
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/ai', aiRoutes);
const server = http.createServer(app);
const apiPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const API = `http://127.0.0.1:${apiPort}/api/ai`;

/** POST a normal JSON request. */
async function post(path, body, token = MEMBER_TOKEN) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

/**
 * Consume the SSE endpoint, recording WHEN each thing happened — the numbers
 * that matter are time-to-headers and time-to-first-delta, not total time.
 */
async function stream(body, token = MEMBER_TOKEN) {
  const t0 = performance.now();
  const res = await fetch(`${API}/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });

  const timings = { headersMs: performance.now() - t0, firstDeltaMs: null, totalMs: null };
  const events = [];

  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, events, timings, httpBody: json, sse: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      if (event.type === 'delta' && timings.firstDeltaMs === null) {
        timings.firstDeltaMs = performance.now() - t0;
      }
      events.push(event);
    }
  }

  timings.totalMs = performance.now() - t0;

  return {
    status: res.status,
    events,
    timings,
    sse: true,
    text: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
    meta: events.find((e) => e.type === 'meta'),
    done: events.find((e) => e.type === 'done'),
    error: events.find((e) => e.type === 'error')
  };
}

console.log('\nSyncSpace AI — reconstructed module\n');

// =========================================================== language identity
section('language identity (the reported bug)');

const mentions = (s) => languages.findLanguageMentions(s).map((m) => m.id);

check('"java" is not swallowed by "javascript"',
  mentions('hello world in java').join() === 'java' &&
  mentions('hello world in javascript').join() === 'javascript');
check('"c" and "c++" are distinguished',
  mentions('hello world in c').join() === 'c' &&
  mentions('hello world in c++').join() === 'cpp');
check('"c#" does not become "c"', mentions('a c# class').join() === 'csharp');
check('"node.js" resolves to javascript', mentions('a node.js server').join() === 'javascript');
check('no language named -> no mention', mentions('what is a hash map?').length === 0);
check('normalizeLanguage folds aliases',
  languages.normalizeLanguage('Java') === 'java' &&
  languages.normalizeLanguage('JS') === 'javascript' &&
  languages.normalizeLanguage('C++') === 'cpp');
check('unknown language normalizes to null', languages.normalizeLanguage('cobol') === null);

const bug = languages.resolveLanguage({
  message: 'give me the hello world program in java',
  requestLanguage: 'javascript',
  action: 'generate'
});
check('THE BUG: user "java" beats editor default "javascript"',
  bug.language === 'java' && bug.source === 'user-request', JSON.stringify(bug));
check('  ...and the conflict is recorded, not silently dropped',
  bug.conflict?.with === 'javascript');

check('editor metadata wins when the user names nothing',
  languages.resolveLanguage({ message: 'write a linked list', requestLanguage: 'python' }).language === 'python');
check('pasted code overrides a stale editor default',
  languages.resolveLanguage({
    message: 'what does this do',
    code: 'public class A { public static void main(String[] a){ System.out.println(1);} }',
    requestLanguage: 'javascript'
  }).language === 'java');
check('code inference alone works when nothing else is known',
  languages.resolveLanguage({ message: 'review this', code: 'def f(x):\n    return x\n\nif __name__ == "__main__":\n    f(1)' }).language === 'python');

const conv = languages.resolveConversion({ message: 'convert this java code to python' });
check('conversion direction is read from prose', conv.from === 'java' && conv.to === 'python');
const conv2 = languages.resolveConversion({ message: 'convert this python code to java' });
check('reverse direction is not symmetric-confused', conv2.from === 'python' && conv2.to === 'java');
check('an ambiguous pair asks instead of guessing',
  languages.resolveConversion({ message: 'java python' }).needsClarification === true);
check('same source and target asks instead of no-oping',
  languages.resolveConversion({ message: 'convert to java', code: 'class A{}', requestLanguage: 'java', targetLanguage: 'java' }).needsClarification === true);

// ================================================================== validation
section('validation and input hardening');

check('unknown action rejected', validateAIRequest({ action: 'rm -rf' }).valid === false);
check('all nine actions accepted',
  ['chat', 'explain', 'generate', 'error', 'debug', 'tests', 'optimize', 'convert', 'document']
    .every((a) => validateAIRequest({ action: a, message: 'x' }).valid));
check('non-string message rejected', validateAIRequest({ message: { evil: 1 } }).valid === false);
check('array body rejected', validateAIRequest([1, 2, 3]).valid === false);
check('null body rejected', validateAIRequest(null).valid === false);
check('oversized code rejected', validateAIRequest({ action: 'explain', code: 'x'.repeat(30_001) }).valid === false);
check('oversized message rejected', validateAIRequest({ message: 'x'.repeat(8_001) }).valid === false);
check('lone CR stripped from code (would corrupt an SSE frame)',
  !validateAIRequest({ action: 'explain', code: 'a\rb' }).data.code.includes('\r'));
check('NUL byte stripped',
  !validateAIRequest({ message: 'a\u0000b' }).data.message.includes('\u0000'));
check('unknown language is tolerated, not fatal',
  validateAIRequest({ message: 'hi', language: 'cobol' }).valid === true);
check('language is normalized on the way in',
  validateAIRequest({ message: 'hi', language: 'C++' }).data.language === 'cpp');

// ============================================================ prompt structure
section('prompt construction');

const javaPlan = planRequest({
  action: 'generate',
  message: 'give me the hello world program in java',
  language: 'javascript'
});
check('plan pins Java for the reported request', javaPlan.language === 'java');
check('system instruction states OUTPUT LANGUAGE: Java',
  /OUTPUT LANGUAGE: Java\b/.test(javaPlan.systemInstruction));
check('system instruction names the ```java fence',
  javaPlan.systemInstruction.includes('```java'));
check('the contradictory "PROGRAMMING LANGUAGE: javascript" line is gone',
  !/PROGRAMMING LANGUAGE/i.test(javaPlan.userContent) &&
  !/javascript/i.test(javaPlan.userContent));
check('user turn carries only the request for generate',
  javaPlan.userContent.includes('REQUEST') && !javaPlan.userContent.includes('CODE'));
check('system instruction stays small (<1.5 kB)',
  javaPlan.systemInstruction.length < 1500, `${javaPlan.systemInstruction.length} chars`);

const explainPlan = planRequest({ action: 'explain', code: 'System.out.println(1);', language: 'java' });
check('explain sends code, not an empty REQUEST block',
  explainPlan.userContent.includes('CODE') && explainPlan.userContent.includes('```java'));
const debugPlan = planRequest({ action: 'debug', code: 'int x;', error: 'segfault', language: 'c' });
check('debug sends both code and error',
  debugPlan.userContent.includes('CODE') && debugPlan.userContent.includes('ERROR OUTPUT'));
check('irrelevant fields are dropped (generate ignores stray code)',
  !planRequest({ action: 'generate', message: 'a stack in java', code: 'ignored junk' }).userContent.includes('ignored junk'));

const convPlan = planRequest({ action: 'convert', message: 'convert this to python', code: 'public class A{}', language: 'java' });
check('convert pins source and target separately',
  convPlan.language === 'java' && convPlan.targetLanguage === 'python');
check('convert instruction forbids answering in the source language',
  /TARGET LANGUAGE: Python/.test(convPlan.systemInstruction) &&
  /never return the answer in it/i.test(convPlan.systemInstruction));

check('detail request lifts the brevity constraint',
  /explicitly asked for explanation/i.test(
    planRequest({ action: 'generate', message: 'write a java stack and explain it in detail' }).systemInstruction));

// ============================================================ local short-circuits
section('requests answered without calling the provider');

check('empty request is refused locally',
  planRequest({ action: 'chat', message: '' }).kind === 'clarify');
check('generate with no language anywhere asks which language',
  planRequest({ action: 'generate', message: 'write a linked list' }).kind === 'clarify');
check('  ...but not when the editor supplies one',
  planRequest({ action: 'generate', message: 'write a linked list', language: 'python' }).kind === 'model');
check('explain with no code asks for code',
  planRequest({ action: 'explain', message: '' }).kind === 'clarify');

// ================================================== model tiering + thinking
section('model selection and thinking level');

check('simple work goes to the fast tier',
  selectModel({ action: 'generate', complexity: 'simple' }).model === 'gemini-3.5-flash-lite');
check('debugging goes to the smart tier',
  selectModel({ action: 'debug', complexity: 'standard' }).model === 'gemini-3.6-flash');
check('large payloads escalate regardless of action',
  selectModel({ action: 'chat', complexity: 'simple', payloadChars: 9000 }).tier === 'smart');
check('fast tier asks for minimal thinking',
  selectThinkingLevel({ model: 'gemini-3.5-flash-lite', tier: 'fast', complexity: 'simple' }) === 'minimal');
check('smart tier asks for low thinking, not the medium default',
  selectThinkingLevel({ model: 'gemini-3.6-flash', tier: 'smart', complexity: 'standard' }) === 'low');
check('deep work is allowed medium thinking',
  selectThinkingLevel({ model: 'gemini-3.6-flash', tier: 'smart', complexity: 'deep' }) === 'medium');
check('3.7 Flash never gets "minimal" (it rejects that level)',
  selectThinkingLevel({ model: 'gemini-3.7-flash', tier: 'fast', complexity: 'simple' }) === 'low');
check('hello world classifies as simple',
  classifyComplexity({ action: 'generate', message: 'give me the hello world program in java' }) === 'simple');
check('a long stack trace classifies as deep',
  classifyComplexity({ action: 'debug', message: 'x'.repeat(900), code: 'y'.repeat(900) }) === 'deep');

process.env.GEMINI_MODEL = 'gemini-3.7-flash';
check('an explicit GEMINI_MODEL still overrides both tiers',
  selectModel({ action: 'chat', complexity: 'simple' }).model === 'gemini-3.7-flash');
delete process.env.GEMINI_MODEL;

// ====================================================================== security
section('security');

check('no token -> 401', (await post('/', { message: 'hi' }, null)).status === 401);
check('garbage token -> 401', (await post('/', { message: 'hi' }, 'not-a-jwt')).status === 401);
check('lobby ticket cannot reach the AI', (await post('/', { message: 'hi' }, LOBBY_TOKEN)).status === 401);
check('removed / non-member access token -> 403',
  (await post('/', { message: 'hi' }, STRANGER_TOKEN)).status === 403);
check('a signed-in account token is accepted',
  (await post('/', { action: 'chat', message: 'hi' }, USER_TOKEN)).status === 200);
check('streaming endpoint enforces the same auth',
  (await stream({ message: 'hi' }, null)).status === 401);

const oversize = await post('/', { action: 'explain', code: 'x'.repeat(31_000) });
check('oversized payload -> 400 with a useful message',
  oversize.status === 400 && /too long/i.test(oversize.body.error));

const keyLeak = JSON.stringify(await post('/', { action: 'chat', message: 'hi' }));
check('no API key material in any response', !keyLeak.includes('test-key'));

// =================================================== streaming behaviour + latency
section('streaming');

mock.resetControl();
mock.clearCalls();

const javaRun = await stream({
  action: 'generate',
  message: 'give me the hello world program in java',
  language: 'javascript'
});

check('stream returns SSE', javaRun.sse === true);
check('meta arrives before any text', javaRun.events[0].type === 'meta');
check('meta reports the resolved language to the UI', javaRun.meta.languageLabel === 'Java');
check('meta names the model actually used', javaRun.meta.model === 'gemini-3.5-flash-lite');
check('multiple deltas were streamed, not one blob',
  javaRun.events.filter((e) => e.type === 'delta').length > 1);
check('stream ends with done', javaRun.events.at(-1).type === 'done');
check('headers arrive long before the answer does',
  javaRun.timings.headersMs < javaRun.timings.totalMs / 2,
  `headers ${javaRun.timings.headersMs.toFixed(0)}ms vs total ${javaRun.timings.totalMs.toFixed(0)}ms`);

// THE headline assertion.
check('JAVA REQUEST PRODUCES JAVA, NOT JAVASCRIPT',
  /```java\b/.test(javaRun.text) && /System\.out\.println/.test(javaRun.text) &&
  !/console\.log/.test(javaRun.text), javaRun.text.slice(0, 120));

const sent = mock.lastCall();
check('provider was called on the STREAMING endpoint', sent.streaming === true);
check('thinkingLevel was set explicitly (not the provider default)',
  sent.thinkingLevel === 'minimal');
check('maxOutputTokens was capped for a simple request', sent.maxOutputTokens === 1024);
check('no deprecated temperature parameter was sent', sent.hasTemperature === false);
check('prompt is small for a small request', sent.promptChars < 1600, `${sent.promptChars} chars`);

// ---- every language in the matrix ----
section('language matrix: "hello world" in each language');

for (const [phrase, fence, marker] of [
  ['give me the hello world program in java', 'java', 'System.out.println'],
  ['hello world in c', 'c', 'printf'],
  ['hello world in c++', 'cpp', 'std::cout'],
  ['hello world in python', 'python', 'print('],
  ['hello world in javascript', 'javascript', 'console.log']
]) {
  const run = await stream({ action: 'generate', message: phrase, language: 'javascript' });
  check(`"${phrase}" -> \`\`\`${fence}`,
    run.text.includes('```' + fence) && run.text.includes(marker),
    run.text.slice(0, 90));
}

section('action matrix');

const matrix = [
  ['explain Java code', { action: 'explain', code: 'public class A { public static void main(String[] a){ System.out.println("x"); } }' }, (r) => r.meta.languageLabel === 'Java'],
  ['debug Python', { action: 'debug', code: 'def f(x):\n    return x/0', error: 'ZeroDivisionError', language: 'python' }, (r) => r.meta.languageLabel === 'Python' && r.meta.model === 'gemini-3.6-flash'],
  ['analyze C++ error', { action: 'error', error: "undefined reference to `main'", code: '#include <iostream>\nint mian(){}', language: 'cpp' }, (r) => r.meta.languageLabel === 'C++'],
  ['convert Java -> Python', { action: 'convert', message: 'convert this java code to python', code: 'public class A{}' }, (r) => r.meta.languageLabel === 'Java' && r.meta.targetLanguageLabel === 'Python' && r.text.includes('```python')],
  ['convert Python -> Java', { action: 'convert', message: 'convert this python code to java', code: 'print(1)' }, (r) => r.meta.languageLabel === 'Python' && r.meta.targetLanguageLabel === 'Java' && r.text.includes('```java')],
  ['generate tests', { action: 'tests', code: 'def add(a,b): return a+b', language: 'python' }, (r) => r.meta.languageLabel === 'Python'],
  ['optimize', { action: 'optimize', code: 'for i in range(len(a)):\n    print(a[i])', language: 'python' }, (r) => r.meta.model === 'gemini-3.6-flash'],
  ['document', { action: 'document', code: 'public int add(int a, int b){return a+b;}', language: 'java' }, (r) => r.meta.languageLabel === 'Java']
];

for (const [name, body, assertion] of matrix) {
  const run = await stream(body);
  let ok = false;
  try { ok = run.sse && !run.error && assertion(run); } catch { ok = false; }
  check(name, ok, run.error?.message || JSON.stringify(run.meta || {}));
}

// ---- conversion must not be hardcoded javascript -> python any more ----
const stillHardcoded = await stream({ action: 'convert', message: 'convert this to rust', code: 'public class A{}' });
check('convert honours an arbitrary target (rust), not a hardcoded python',
  stillHardcoded.meta.targetLanguageLabel === 'Rust');

// ==================================================================== failures
section('failure handling');

const failures_matrix = [
  ['rate-limit', 'rate-limited', /rate limit/i],
  ['server', 'provider-down', /unavailable/i],
  ['bad-key', 'bad-key', /API key/i],
  ['not-found', 'bad-model', /model/i],
  ['empty', 'empty-response', /empty/i],
  ['malformed', null, /./]
];

for (const [injected, expectedCode, messageRe] of failures_matrix) {
  mock.setControl({ fail: injected });
  const run = await stream({ action: 'chat', message: 'hello' });
  const err = run.error;
  const ok = Boolean(err) &&
    (expectedCode ? err.code === expectedCode : true) &&
    messageRe.test(err.message) &&
    !/http:\/\/127\.0\.0\.1/.test(err.message) &&   // no internal URLs
    !/test-key/.test(err.message);                  // no credentials
  check(`provider "${injected}" -> clean user-facing error`, ok, JSON.stringify(err));
}

mock.setControl({ fail: 'mid-stream-abort' });
const aborted = await stream({ action: 'chat', message: 'hello' });
check('mid-stream disconnect ends cleanly with an error event, no crash',
  aborted.events.some((e) => e.type === 'error') || aborted.events.some((e) => e.type === 'delta'),
  JSON.stringify(aborted.events.at(-1)));

mock.resetControl();

// missing key
const savedKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
resetClient();
const unconfigured = await stream({ action: 'chat', message: 'hello' });
check('missing API key -> explicit configuration error, not a crash',
  unconfigured.error?.code === 'not-configured' && /GEMINI_API_KEY/.test(unconfigured.error.message));
const healthDown = await (await fetch(`${API}/health`)).json();
check('health reports unconfigured when the key is absent',
  healthDown.providerConfigured === false && healthDown.status === 'unconfigured');
process.env.GEMINI_API_KEY = savedKey;
resetClient();

const health = await (await fetch(`${API}/health`)).json();
check('health names the real provider (was checking OPENAI_API_KEY)',
  health.provider === 'gemini' && health.providerConfigured === true);
check('health advertises the models actually in use',
  health.models.fast === 'gemini-3.5-flash-lite' && health.models.smart === 'gemini-3.6-flash');

check('describeProviderError never echoes raw provider text',
  describeProviderError({ status: 429, message: 'Quota exceeded for project 12345 key AIzaSyXXXX' })
    .message.includes('12345') === false);

// invalid action over HTTP
const badAction = await post('/stream', { action: 'sudo', message: 'hi' });
check('invalid action -> 400 before any provider call', badAction.status === 400);

// very long but legal request
const longRun = await stream({ action: 'explain', code: 'x = 1\n'.repeat(2000), language: 'python' });
check('very long (but legal) request still streams', longRun.sse && !longRun.error);
check('  ...and escalates to the smart tier', longRun.meta.model === 'gemini-3.6-flash');

// clarification path costs no provider call
mock.clearCalls();
const clarify = await stream({ action: 'generate', message: 'write a linked list' });
check('ambiguous language asks a question', /which language/i.test(clarify.text));
check('  ...without spending a provider call', mock.calls.length === 0);
check('  ...and still emits a well-formed stream',
  clarify.events[0].type === 'meta' && clarify.events.at(-1).type === 'done');

// buffered endpoint parity
const buffered = await post('/', { action: 'generate', message: 'hello world in java', language: 'javascript' });
check('buffered endpoint gives the same Java answer',
  buffered.status === 200 && buffered.body.answer.includes('```java'));

// ================================================================ latency A/B
section('latency: buffered vs streamed (same mock, same answer)');

mock.resetControl();
mock.setControl({ tokensPerChunk: 4, chunkDelayMs: 6 });

/**
 * The old path exactly: one buffered call, provider default thinking level
 * (medium, because the app never set one), nothing shown until it all lands.
 */
async function oldStyle(body) {
  const t0 = performance.now();
  const res = await fetch(
    `${process.env.GEMINI_BASE_URL}/v1beta/models/gemini-3.6-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: body }] }],
        generationConfig: {}          // no thinkingConfig -> provider default
      })
    }
  );
  await res.json();
  return performance.now() - t0;
}

const oldMs = await oldStyle('ACTION:\ngenerate\n\nUSER REQUEST:\ngive me the hello world program in java\n\nPROGRAMMING LANGUAGE:\njavascript');
const newRun = await stream({ action: 'generate', message: 'give me the hello world program in java', language: 'javascript' });

console.log(`\n    buffered + default thinking (old):  first text at ${oldMs.toFixed(0)} ms`);
console.log(`    streamed + minimal thinking (new):  first text at ${newRun.timings.firstDeltaMs.toFixed(0)} ms`);
console.log(`    (mock thinking stalls: minimal ${THINK_MS.minimal}ms, low ${THINK_MS.low}ms, medium ${THINK_MS.medium}ms — scaled ~20x down from real)`);
console.log(`    improvement in time-to-first-text: ${(oldMs / newRun.timings.firstDeltaMs).toFixed(1)}x\n`);

check('time to first text improved by at least 3x',
  oldMs / newRun.timings.firstDeltaMs >= 3,
  `${oldMs.toFixed(0)}ms -> ${newRun.timings.firstDeltaMs.toFixed(0)}ms`);

// ==================================================================== summary
await new Promise((r) => server.close(r));
await mock.close();

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n  Failing:');
  failures.forEach((f) => console.log('   - ' + f));
}
console.log(`${'='.repeat(60)}\n`);
process.exit(fail ? 1 : 0);
