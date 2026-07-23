/**
 * Loader hook for the headless regression suite.
 *
 * It does two things:
 *   1. Compiles .jsx on the fly (esbuild).
 *   2. Redirects `react-konva` and `konva` to lightweight stubs.
 *
 * The stubs render nothing, but that is exactly the point: a React component's
 * body — and every helper it calls — still executes in full when its element is
 * created and rendered. So shapePoints(), heartPath(), withEffects(),
 * renderStroke(), connectorRoute() and friends all run for real, and any
 * exception they raise surfaces exactly as it would in the browser. What we
 * cannot do headlessly is rasterise pixels, which is not what we are testing.
 */
import { transformSync } from 'esbuild';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const STUB_KONVA = new URL('./stub-konva.mjs', import.meta.url).href;
const STUB_REACT_KONVA = new URL('./stub-react-konva.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'konva') return { url: STUB_KONVA, shortCircuit: true };
  if (specifier === 'react-konva') return { url: STUB_REACT_KONVA, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.jsx')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, {
      loader: 'jsx',
      format: 'esm',
      jsx: 'automatic',
      sourcefile: url
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return next(url, context);
}
