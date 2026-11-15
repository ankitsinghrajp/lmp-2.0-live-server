/**
 * Pulls COMPLETE topic objects out of a streamed {"topics":[{...},{...}]}
 * response, one at a time, as soon as each object's closing brace arrives.
 * String/escape aware, so braces inside text (e.g. \mathrm{H_2O}) never
 * confuse it.
 */
export function createTopicExtractor(onTopicObject) {
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
      // Before the topics array: skip to its opening "["
      if (!arrayStarted) {
        if (inString) trackString(ch);
        else if (ch === '"') inString = true;
        else if (ch === "[") arrayStarted = true;
        continue;
      }

      // Between topic objects: wait for the next "{"
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          buffer = "{";
        }
        continue;
      }

      // Inside a topic object
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
              "[Important Topics] Skipped an unparseable streamed topic:",
              error.message
            );
          }

          buffer = "";
          if (parsed) onTopicObject(parsed);
        }
      }
    }
  };
}