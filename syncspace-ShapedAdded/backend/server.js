import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { connectDB } from "./config/db.js";
import { setupSocket, setPersistence } from "./services/socketService.js";
import { setPersistence as setStorePersistence } from "./services/workspaceStore.js";
import workspaceRoutes from "./routes/workspaceRoutes.js";

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "syncspace-backend", time: new Date() });
});

app.use("/api/workspaces", workspaceRoutes);

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
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST", "PATCH", "DELETE"] }
});

const connected = await connectDB();
setPersistence(connected);       // Yjs snapshots
setStorePersistence(connected);  // workspaces / members / requests
setupSocket(io);

server.listen(PORT, () => {
  console.log(`\n  SyncSpace backend  ->  http://localhost:${PORT}`);
  console.log(`  Health check       ->  http://localhost:${PORT}/api/health`);
  console.log(`  Persistence        ->  ${connected ? "MongoDB" : "memory only (workspaces reset on restart)"}\n`);
});
