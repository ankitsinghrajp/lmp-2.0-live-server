import express from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { verifyEmailMiddleware } from "../middlewares/mailVerify.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";
import { upload as pdfUpload } from "../middlewares/upload.middleware.js";

import { rateLimitByPlan } from "../rateLimiter.js";
import { LastMinutePanelImportantTopics, LastMinutePanelSummary } from "../controllers/lastminute.controller.js";
import { diagramImageAnalysis } from "../controllers/image.controller.js";
import { chatWithPdf } from "../controllers/chatWithPdf.controller.js";
import { uploadPdfAndProcess } from "../controllers/uploadPdfAndProcess.controller.js";
import { premiumOnly } from "../middlewares/premiumOnly.middleware.js";
import { pdfUploadQuotaCheck } from "../middlewares/pdfQuota.middleware.js";
import { redis } from "../libs/redis.js";
import { importantQuestionGeneratorStream } from "../controllers/importantQuestionGenerator.controller.js";
import { predictedQuestionGeneratorStream } from "../controllers/predictedQuestion.controller.js";
import { mcqGeneratorStream } from "../controllers/lastMinuteMCQGenerator.controller.js";
import { LastMinutePanelMemoryBooster } from "../controllers/LastMinuteBooster.controller.js";
import { lastNightAICoachStream } from "../controllers/lastNightAiCoachGenerator.controller.js";
import { quizGeneratorStream } from "../controllers/quizMCQGenerator.controller.js";
import { askAnyQuestion } from "../controllers/askAny.controller.js";
import { summarizer } from "../controllers/summarizer.controller.js";
import { smartChapterSummaryStream } from "../controllers/smartChapterSummary.controller.js";
import { chapterWiseShortNotesStream } from "../controllers/shortNotes.controller.js";
import { chapterWiseMindMap } from "../controllers/mindmap.controller.js";
import { chapterWiseQuestionsGeneratorStream } from "../controllers/studyQuestionsStreams.controller.js";
import { generatePYQsStream } from "../controllers/pyqGenerator.controller.js";
import {topperStyleAnswer} from "../controllers/topperStyleAnswer.controller.js";

const router = express.Router();
router.use(verifyJWT);
// router.use(verifyEmailMiddleware);


router.use(rateLimitByPlan);

router.post("/summarizer",upload.fields([
    {
        name:"image",
        maxCount:1
    }
]),summarizer);


// Topper Style Answer API Routes 
router.post("/topper-style-answer",topperStyleAnswer);

router.post("/important-question-generator",chapterWiseQuestionsGeneratorStream);
router.post("/important-question-generator/stream",importantQuestionGeneratorStream);
router.post("/ask-any",upload.fields([
    {
        name:"image",
        maxCount:1
    }
]),askAnyQuestion);




// Chat with pdf routes Premium Only routes
// router.use(premiumOnly);

router.post("/get-pyqs",generatePYQsStream);
router.post("/image-analysis",upload.fields([
    {
        name:"image",
        maxCount:1
    }
]),diagramImageAnalysis);
router.post("/quiz-mcq-fillups",quizGeneratorStream);





router.post("/chapter-wise-study/summary",smartChapterSummaryStream);
router.post("/chapter-wise-study/short-notes", chapterWiseShortNotesStream);
router.post("/chapter-wise-study/important-questions",chapterWiseQuestionsGeneratorStream);
router.post("/chapter-wise-study/mind-map",chapterWiseMindMap);

// Last Night Before Exam Routes
router.post("/last-night-before-exam/summary",LastMinutePanelSummary);
router.post("/last-night-before-exam/important-topics",LastMinutePanelImportantTopics);
router.post("/last-night-before-exam/predicted-questions",predictedQuestionGeneratorStream);
router.post("/last-night-before-exam/mcqs",mcqGeneratorStream);
router.post("/last-night-before-exam/memory-booster",LastMinutePanelMemoryBooster);
router.post("/last-night-before-exam/ai-coach",lastNightAICoachStream);


router.use(pdfUploadQuotaCheck);

router.post("/upload-pdf", pdfUpload.single("pdf"), uploadPdfAndProcess);
router.post("/chat-with-pdf", chatWithPdf);


// for testing only
router.get("/test-redis", async (req, res) => {
  try {
    const set = await redis.set("test123", "hello world", { ex: 60 });
    const get = await redis.get("test123");

    return res.json({ set, get });
  } catch (e) {
    return res.json({ error: e.message });
  }
});


export default router;