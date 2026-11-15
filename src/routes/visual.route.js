import express from "express";
import { visualController } from "../controllers/visual.controller.js";

const router = express.Router();

// JSON body, answers with an SSE stream (or plain JSON on a cache hit).
router.post("/generation", visualController);

export default router;