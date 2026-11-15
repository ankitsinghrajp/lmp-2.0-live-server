const WARN_LINES = 20;
const WARN_WIDTH = 60;

const MERMAID_START =
  /^\s*(flowchart|graph\s+(TD|TB|LR|RL|BT)|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie)\b/im;

// Characters that are safe to swap for a plain equivalent.
const REPLACEMENTS = [
  [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " "], // odd spaces
  [/[\u200B-\u200D\u2060\uFEFF]/g, ""], // zero-width characters
  [/[\u2212\u2013\u2014\u2500\u2501\u2504\u2508]/g, "-"], // minus, dashes, box lines
  [/[\u2502\u2503\u2506\u250A]/g, "|"], // box vertical lines
  [/[\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C]/g, "+"], // box corners
  [/[\u2191\u25B2]/g, "^"],
  [/[\u2193\u25BC]/g, "v"],
  [/[\u2190\u25C0]/g, "<"],
  [/[\u2192\u25B6]/g, ">"],
  [/[\u2113]/g, "l"], // script small l
  [/[\u2018\u2019]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
];

/** Removes code fences, tabs, odd characters, blank edges and common indent. */
function cleanDiagram(raw) {
  let text = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ");

  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  // Remove remaining control characters, but keep line breaks.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "");

  // Strip ``` fences if the model added them anyway.
  text = text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n");

  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  // Remove indentation shared by every line, but keep relative spacing.
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^ */)[0].length);
  const common = indents.length ? Math.min(...indents) : 0;

  return lines.map((line) => line.slice(common)).join("\n");
}

/**
 * Lenient on purpose: only an empty response or Mermaid syntax is rejected.
 * @returns {{ valid: boolean, code: string, markdown: string, issues: string[] }}
 * `code` is the cleaned diagram text, `markdown` the same inside a ```text fence.
 */
export function validateVisual({ raw }) {
  const code = cleanDiagram(raw);
  const issues = [];

  if (!code) {
    return {
      valid: false,
      code: "",
      markdown: "",
      issues: ["The response was empty. Return the diagram."],
    };
  }

  if (MERMAID_START.test(code)) {
    issues.push("Mermaid syntax is not allowed. Draw a plain text diagram.");
  }

  // Size problems are only logged, they never reject a diagram.
  const lines = code.split("\n");
  const width = Math.max(...lines.map((line) => line.length));

  if (lines.length > WARN_LINES || width > WARN_WIDTH) {
    console.warn(
      `[Visual] Large diagram accepted: ${lines.length} lines, ${width} characters wide`
    );
  }

  return {
    valid: issues.length === 0,
    code,
    markdown: "```text\n" + code + "\n```",
    issues,
  };
}