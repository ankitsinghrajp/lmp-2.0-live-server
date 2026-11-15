/**
 * Pulls COMPLETE question objects out of a streamed
 * {"questions":[{...},{...}]} response, one at a time, as soon as each
 * object's closing brace arrives. String/escape aware, so braces inside
 * question text (e.g. \mathrm{H_2O}) never confuse it.
 */
export function createQuestionExtractor(onQuestionObject) {
  let arrayStarted = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let buffer = "";

  const trackString = (ch) => {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = false;
    }
  };

  return function push(chunk) {
    for (const ch of chunk) {
      // Before the questions array: skip to its opening "["
      if (!arrayStarted) {
        if (inString) trackString(ch);
        else if (ch === '"') inString = true;
        else if (ch === "[") arrayStarted = true;
        continue;
      }

      // Between question objects: wait for the next "{"
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          buffer = "{";
        }
        continue;
      }

      // Inside a question object
      buffer += ch;

      if (inString) {
        trackString(ch);
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;

        if (depth === 0) {
          let parsed = null;

          try {
            parsed = JSON.parse(buffer);
          } catch (error) {
            console.error(
              "[Predicted Questions] Skipped an unparseable streamed question:",
              error.message
            );
          }

          buffer = "";
          if (parsed) onQuestionObject(parsed);
        }
      }
    }
  };
}