import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { connectDB } from './config/db.js';
import { setupSocket, setPersistence } from './services/socketService.js';

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'syncspace-backend', time: new Date() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] }
});

const connected = await connectDB();
setPersistence(connected);
setupSocket(io);

server.listen(PORT, () => {
  console.log(`\n  SyncSpace backend  ->  http://localhost:${PORT}`);
  console.log(`  Health check       ->  http://localhost:${PORT}/api/health`);
  console.log(`  Persistence        ->  ${connected ? 'MongoDB' : 'memory only'}\n`);
});
