import mongoose from 'mongoose';

/**
 * Blueprint Part 8.4 - updatelogs collection.
 *
 * docstates (8.3) answers "what does the board look like NOW?" — one row per
 * room, overwritten every two seconds. It is a photograph.
 *
 * updatelogs answers "how did it GET here?" — one row per Yjs update, appended
 * and never modified. It is the film reel. Replay needs the reel, not the
 * photograph, which is why this collection has to exist separately.
 *
 * `payload` is the raw binary Yjs update exactly as it came off the wire — the
 * same bytes that were relayed to the other collaborators. Storing the opaque
 * update rather than a decoded description of it is what keeps replay honest:
 * re-applying these buffers in order reconstructs the document byte for byte,
 * with no interpretation layer that could drift from the real one.
 *
 * `seq` is a per-room monotonic counter. Timestamps alone are not enough — two
 * updates can land inside the same millisecond, and Mongo does not promise to
 * return them in insertion order without an explicit sort key.
 */

const updateLogSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },

    // per-room ordinal: 0, 1, 2, ... This is the replay slider's x-axis.
    seq: { type: Number, required: true },

    // the opaque Yjs update. Buffer, not JSON — same discipline as DocState.
    payload: { type: Buffer, required: true },

    // who caused it. Useful in the scrubber ("Serah drew this"), and it costs
    // nothing because the socket already knows both fields.
    userId: { type: String },
    username: { type: String },

    timestamp: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

// The query replay actually runs: "every update for this room, in order."
updateLogSchema.index({ roomId: 1, seq: 1 }, { unique: true });

export default mongoose.model('UpdateLog', updateLogSchema);
