
import { inngest } from "../libs/inngest.js";
import { redis } from "../libs/redis.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { parseSubject } from "../utils/helper.js";

const chapterWiseStudyQuestions = asyncHandler(async (req, res) => {
  const { className, subject, chapter } = req.body;

  if (!className || !subject || !chapter) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing class, subject or chapter"));
  }

  const { mainSubject } = parseSubject(subject);

  const cacheKey = `lmp:studyq:${className}:${mainSubject}:${chapter}`;
  const pendingKey = `lmp:studyq:pending:${className}:${mainSubject}:${chapter}`;

  /* -------------------- CACHE CHECK -------------------- */
  try {
    const redisCached = await redis.get(cacheKey);

    if (redisCached) {
      const finalData =
        typeof redisCached === "object"
          ? redisCached
          : JSON.parse(redisCached);

      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            finalData,
            "Important Questions Ready (Redis)"
          )
        );
    }
  } catch (err) {
    console.error("Redis GET error:", err);
  }

  /* -------------------- PENDING CHECK -------------------- */
  const isPending = await redis.get(pendingKey);
  if (isPending) {
    return res
      .status(202)
      .json(
        new ApiResponse(
          202,
          null,
          "Important questions generation already in progress"
        )
      );
  }

  /* -------------------- ACQUIRE LOCK -------------------- */
  const lockAcquired = await redis.set(pendingKey, "1", {
    nx: true,
    ex: 150,
  });

  if (!lockAcquired) {
    return res
      .status(202)
      .json(
        new ApiResponse(
          202,
          null,
          "Important questions generation already in progress"
        )
      );
  }

  try {
    // ✅ DIRECTLY AWAIT INNGEST
    await inngest.send({
      name: "lmp/generate.chapterWiseStudyQuestions",
      data: { className, subject, chapter },
    });

    return res
      .status(202)
      .json(
        new ApiResponse(
          202,
          null,
          "Important questions generation queued"
        )
      );
  } catch (err) {
    console.error("Queue error:", err);

    // 🔁 rollback lock on failure
    await redis.del(pendingKey);

    return res
      .status(500)
      .json(
        new ApiResponse(
          500,
          null,
          "Failed to queue generation"
        )
      );
  }
});


export {chapterWiseStudyQuestions}