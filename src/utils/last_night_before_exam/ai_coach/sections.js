/**
 * Splits a streamed Markdown response into "## " blocks.
 *
 * onBlock(text) is called with the body of a block (the heading line is
 * dropped) as soon as the NEXT "## " heading starts, and for the last block
 * when end() is called. Text before the first heading and code-fence lines are
 * ignored.
 */
export function createStepExtractor(onBlock) {
  let pending = ""; // incomplete last line
  let current = null; // body lines of the block being read

  const flush = () => {
    if (current === null) return;

    const body = current.join("\n").trim();
    current = null;

    if (body) onBlock(body);
  };

  const handleLine = (line) => {
    if (/^\s*```/.test(line)) return;

    if (/^\s{0,3}##(?!#)/.test(line)) {
      flush();
      current = [];
      return;
    }

    if (current !== null) current.push(line);
  };

  return {
    push(chunk) {
      pending += chunk;

      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        handleLine(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
      }
    },

    end() {
      if (pending) {
        handleLine(pending.replace(/\r$/, ""));
        pending = "";
      }

      flush();
    },
  };
}