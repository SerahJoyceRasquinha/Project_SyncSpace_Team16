import { judge0 } from './judge0.js';
import { piston } from './piston.js';
import { paiza } from './paiza.js';
import { local } from './local.js';

/**
 * The provider registry.
 *
 * Adding a fifth execution backend means writing one adapter that exports
 * { name, label, configured(), hint(), languages(), execute() } and adding it
 * to this object. Nothing else in the codebase needs to change — the
 * orchestrator, the routes and the UI all speak the canonical result shape.
 *
 * DEFAULT_CHAIN is the fallback order used when EXEC_PROVIDERS is not set:
 * the best provider first, the no-signup one last, and the unsandboxed local
 * runner not present at all.
 */
export const PROVIDERS = { judge0, piston, paiza, local };

export const DEFAULT_CHAIN = ['judge0', 'piston', 'paiza'];

/** Resolve the configured chain, dropping unknown names with a warning. */
export function resolveChain() {
  const raw = (process.env.EXEC_PROVIDERS || DEFAULT_CHAIN.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);

  const chain = [];
  for (const name of raw) {
    const p = PROVIDERS[name];
    if (!p) {
      console.warn(`[exec] unknown provider "${name}" in EXEC_PROVIDERS — ignoring`);
      continue;
    }
    chain.push(p);
  }
  return chain;
}
