import mongoose from 'mongoose';

/**
 * One document per workspace. Deliberately NORMALISED:
 *
 *  - `members`          = who is ALLOWED in (durable)
 *  - `pendingRequests`  = who is waiting for the admin (durable)
 *  - CONNECTED users are NOT stored here. Connection is runtime state and lives
 *    in the Socket.io adapter + Yjs awareness. Persisting it would go stale the
 *    moment the process dies, which is exactly the redundancy we want to avoid.
 */

const memberSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const requestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true },
    username: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    resolvedAt: { type: Date }
  },
  { _id: false }
);

const workspaceSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },

    // bcrypt hash of the workspace secret code. Never leaves the server.
    passwordHash: { type: String, required: true },

    adminId: { type: String, required: true },
    adminUsername: { type: String, required: true },

    // 'permission' = admin must approve every joiner
    // 'password'   = correct secret code is enough
    permissionMode: {
      type: String,
      enum: ['permission', 'password'],
      default: 'permission'
    },

    status: { type: String, enum: ['active', 'closed'], default: 'active' },

    members: { type: [memberSchema], default: [] },
    pendingRequests: { type: [requestSchema], default: [] }
  },
  { timestamps: true }
);

export default mongoose.model('Workspace', workspaceSchema);
