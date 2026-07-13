import mongoose from "mongoose";

/**
 * Connects to MongoDB. If MONGO_URI is empty, the server keeps running
 * in memory-only mode (perfect for the very first demo run).
 */
export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.log("[db] MONGO_URI not set -> MEMORY-ONLY mode.");
    return false;
  }
  try {
    await mongoose.connect(uri);
    console.log("[db] MongoDB connected:", mongoose.connection.name);
    return true;
  } catch (err) {
    console.warn("[db] Mongo connection failed -> MEMORY-ONLY mode. Reason:", err.message);
    return false;
  }
}
