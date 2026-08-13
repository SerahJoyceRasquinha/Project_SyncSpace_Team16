import mongoose from 'mongoose';

/**
 * One document per user account. Purely optional — SyncSpace works perfectly
 * without an account — but when present it ties a person to the same identity
 * across every workspace they create or join, and powers the dashboard.
 *
 *  - `userId`      = the SAME id used in Workspace.members[].userId, so a
 *                    member record and an account are linked by one value.
 *  - `workspaces`  = denormalised list of { workspaceId, role } memberships so
 *                    the dashboard can be built without scanning every workspace
 *                    document. The Workspace.members array remains the source
 *                    of truth for authorisation; this is just an index.
 */

const membershipSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    username: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    workspaces: { type: [membershipSchema], default: [] }
  },
  { timestamps: true }
);

export default mongoose.model('User', userSchema);

