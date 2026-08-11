import crypto from "crypto";

// Human-friendly, unambiguous alphabet: no 0/O, no 1/I/L.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** e.g. "WS-7K2M9Q" - short enough to read out loud over a call. */
export function generateWorkspaceId() {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `WS-${out}`;
}

export const newId = () => crypto.randomUUID();
