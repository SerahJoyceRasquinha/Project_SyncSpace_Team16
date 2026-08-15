/**
 * A stand-in for generativelanguage.googleapis.com.
 *
 * It speaks the two wire formats the @google/genai SDK actually uses:
 *
 *   POST /v1beta/models/{model}:generateContent            -> one JSON body
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse -> SSE chunks
 *
 * and it models the one property that dominates real latency: a *thinking*
 * stall before the first visible token, whose length depends on the
 * thinkingLevel in the request. That is what makes the before/after numbers in
 * test-ai.mjs mean something — the buffered path must wait for thinking AND the
 * whole answer, the streamed path only waits for thinking.
 *
 * Everything is deterministic and local: no API key, no network, no cost.
 */
import http from 'http';

/** Rough per-level stall, in ms. Scaled down 20x from real-world so tests are quick. */
export const THINK_MS = {
  minimal: 15,
  low: 60,
  medium: 350,
  high: 900
};

const DEFAULT_LEVEL_BY_MODEL = (model = '') => {
  if (/flash-lite/i.test(model)) return 'minimal';
  return 'medium'; // 3.6 / 3.7 Flash default per Google's model cards
};

export function createMockGemini() {
  /** Test hooks: make the provider misbehave on demand. */
  let control = {
    fail: null,          // 'rate-limit' | 'server' | 'bad-key' | 'malformed' | 'empty' | 'hang' | 'mid-stream-abort'
    chunkDelayMs: 5,
    tokensPerChunk: 6,
    reply: null          // force an exact answer; otherwise it is derived from the prompt
  };

  /** Every request the SDK made, so tests can assert on what was actually sent. */
  const calls = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

    const streaming = req.url.includes('streamGenerateContent');
    const model = decodeURIComponent(
      (req.url.match(/models\/([^:]+):/) || [])[1] || ''
    );

    const cfg = body.generationConfig || {};
    const level = (cfg.thinkingConfig?.thinkingLevel || DEFAULT_LEVEL_BY_MODEL(model))
      .toString().toLowerCase();

    const systemText = (body.systemInstruction?.parts || [])
      .map((p) => p.text || '').join('\n');
    const userText = (body.contents || [])
      .flatMap((c) => c.parts || [])
      .map((p) => p.text || '')
      .join('\n');

    calls.push({
      model,
      streaming,
      thinkingLevel: level,
      maxOutputTokens: cfg.maxOutputTokens,
      hasTemperature: Object.prototype.hasOwnProperty.call(cfg, 'temperature'),
      systemText,
      userText,
      promptChars: systemText.length + userText.length,
      headers: req.headers
    });

    // ---- failure injection ---------------------------------------------
    if (control.fail === 'hang') return; // never answers: exercises timeouts
    if (control.fail === 'bad-key') return send(res, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });
    if (control.fail === 'rate-limit') return send(res, 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric.' } });
    if (control.fail === 'server') return send(res, 503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } });
    if (control.fail === 'not-found') return send(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: `models/${model} is not found for API version v1beta.` } });
    if (control.fail === 'malformed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"candidates": [ this is not json');
    }

    const answer = control.reply ?? synthesize({ systemText, userText });
    const thinkMs = THINK_MS[level] ?? THINK_MS.medium;

    if (control.fail === 'empty') {
      await sleep(thinkMs);
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end();
      }
      return send(res, 200, { candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP' }] });
    }

    // ---- the thinking stall: paid before ANY output, streamed or not ----
    await sleep(thinkMs);

    if (!streaming) {
      // The buffered path additionally waits out the whole generation.
      const pieces = tokenize(answer, control.tokensPerChunk);
      await sleep(pieces.length * control.chunkDelayMs);
      return send(res, 200, {
        candidates: [{ content: { parts: [{ text: answer }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: pieces.length, thoughtsTokenCount: 50 }
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });

    const pieces = tokenize(answer, control.tokensPerChunk);
    for (let i = 0; i < pieces.length; i++) {
      if (control.fail === 'mid-stream-abort' && i === Math.floor(pieces.length / 2)) {
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: pieces[i] }], role: 'model' } }]
      })}\n\n`);
      await sleep(control.chunkDelayMs);
    }
    res.write(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: pieces.length, thoughtsTokenCount: 50 }
    })}\n\n`);
    res.end();
  });

  return {
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      ),
    close: () => new Promise((r) => server.close(r)),
    setControl: (c) => { control = { ...control, ...c }; },
    resetControl: () => {
      control = { fail: null, chunkDelayMs: 5, tokensPerChunk: 6, reply: null };
    },
    calls,
    lastCall: () => calls[calls.length - 1],
    clearCalls: () => { calls.length = 0; }
  };
}

/**
 * A believable answer, derived from the prompt the same way a real model would
 * derive it: it honours the OUTPUT LANGUAGE line the system instruction pins,
 * because the whole point of the language tests is to prove that line is
 * present, correct, and unambiguous.
 */
function synthesize({ systemText, userText }) {
  const pinned = (systemText.match(/OUTPUT LANGUAGE:\s*([^\n(]+)/i) || [])[1];
  const target = (systemText.match(/TARGET LANGUAGE:\s*([^\n(]+)/i) || [])[1];
  const lang = (target || pinned || '').trim().toLowerCase();

  const fence = {
    java: 'java', c: 'c', 'c++': 'cpp', cpp: 'cpp', python: 'python',
    javascript: 'javascript', typescript: 'typescript', go: 'go', rust: 'rust',
    'c#': 'csharp', csharp: 'csharp', ruby: 'ruby', php: 'php', kotlin: 'kotlin',
    swift: 'swift', sql: 'sql'
  }[lang] || (lang ? lang.replace(/[^a-z0-9+#]/g, '') : 'text');

  const hello = {
    java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
    c: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, World!\\n");\n    return 0;\n}',
    cpp: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}',
    python: 'print("Hello, World!")',
    javascript: 'console.log("Hello, World!");'
  }[fence] || `// Hello, World! in ${lang || 'the requested language'}`;

  return `Here is the program.\n\n\`\`\`${fence}\n${hello}\n\`\`\`\n\nRun it with the standard ${lang || 'language'} toolchain.`;
}

function tokenize(text, per) {
  const words = text.split(/(\s+)/);
  const out = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(''));
  return out.filter(Boolean);
}

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
