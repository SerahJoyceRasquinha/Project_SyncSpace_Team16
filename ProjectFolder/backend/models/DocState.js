import mongoose from "mongoose";

/**
 * Blueprint Part 8.3 - docstates collection.
 * One binary Yjs snapshot per room (whiteboard + code editor together).
 */
const docStateSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    state: { type: Buffer, required: true }
  },
  { timestamps: true }
);

export default mongoose.model("DocState", docStateSchema);
