/**
 * Splits a streamed Markdown answer into topic blocks. A block starts at a
 * line that begins with "## " and is complete as soon as the NEXT "## "
 * heading starts (or the stream ends). Text before the first heading is
 * ignored.
 */
export function createMarkdownSectionExtractor(onSection) {
  let buffer = "";

  const drain = (final) => {
    for (;;) {
      const first = buffer.search(/^## /m);

      if (first === -1) {
        if (final) buffer = "";
        return;
      }

      if (first > 0) buffer = buffer.slice(first);

      // Skip the leading "## " so the current heading is not matched again.
      const next = buffer.slice(3).search(/^## /m);

      if (next === -1) {
        if (final) {
          onSection(buffer);
          buffer = "";
        }
        return;
      }

      onSection(buffer.slice(0, next + 3));
      buffer = buffer.slice(next + 3);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      drain(false);
    },
    end() {
      drain(true);
    },
  };
}