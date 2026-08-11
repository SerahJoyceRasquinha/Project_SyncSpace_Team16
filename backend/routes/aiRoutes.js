import express from "express";
import { runAI } from "../services/ai/aiService.js";
import { validateAIRequest } from "../services/ai/validators.js";

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "syncspace-ai",
    status: "healthy",
    providerConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

router.post("/", async (req, res, next) => {
  try {
    const validation = validateAIRequest(req.body);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    const result = await runAI(validation.data);

    return res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;