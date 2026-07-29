import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { connectDB } from "./config/db.js";
import { setupSocket, setPersistence } from "./services/socketService.js";
import { setPersistence as setStorePersistence } from "./services/workspaceStore.js";
import { setPersistence as setLogPersistence } from "./services/updateLogService.js";
import workspaceRoutes from "./routes/workspaceRoutes.js";
import executeRoutes from "./routes/executeRoutes.js";
import { executionStats } from "./services/execution/index.js";

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: CLIENT_ORIGIN }));
// 1mb: the execute endpoint receives whole source files, which easily exceed
// the old 100kb cap. Everything else still validates its own field sizes.
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "syncspace-backend",
    time: new Date(),
    execution: executionStats()
  });
});

app.use("/api/workspaces", workspaceRoutes);
app.use("/api/workspaces/:workspaceId/execute", executeRoutes);

// Malformed or oversized JSON must not become a 500 — the editor shows the
// message verbatim, and "Something went wrong on our side" is a lie here.
// eslint-disable-next-line no-unused-vars
app.use("/api", (err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "That request was not valid JSON." });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "That program is too large to send (limit 1 MB)." });
  }
  return next(err);
});

// 404 for unknown API routes
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

// Central error handler: log the real error, tell the user something human.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err.stack || err.message);
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST", "PATCH", "DELETE"] },
  // engine.io's default receive ceiling is 1 MB, and a message over it does
  // not error politely — it severs the socket at the transport layer. A
  // single sync-update carrying an uploaded image (base64 src inside the
  // shape) can legitimately exceed 1 MB, which would silently kill live
  // collaboration for that user. 8 MB keeps the DoS guard while making
  // room for real content.
  maxHttpBufferSize: 8e6
});

const connected = await connectDB();
setPersistence(connected);       // Yjs snapshots
setStorePersistence(connected);  // workspaces / members / requests
setLogPersistence(connected);     // updatelogs (replay history)
setupSocket(io);

server.listen(PORT, () => {
  console.log(`\n  SyncSpace backend  ->  http://localhost:${PORT}`);
  console.log(`  Health check       ->  http://localhost:${PORT}/api/health`);
  console.log(`  Persistence        ->  ${connected ? "MongoDB" : "memory only (workspaces reset on restart)"}\n`);
});
