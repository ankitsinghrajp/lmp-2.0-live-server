const TRIANGLE_EXAMPLE = String.raw`         A
        / \
 20 cm /   \ 20 cm
      /     \
     /       \
    B---------C
       45 cm`;

const RIGHT_TRIANGLE_EXAMPLE = String.raw`      A
      |\
      | \
 3 cm |  \  5 cm
      |   \
      |    \
      B------C
        4 cm`;

const FORCES_EXAMPLE = String.raw`          ^ N
          |
 <------[ m ]------> F
          |
          v mg`;

const GRAPH_EXAMPLE = String.raw`  y
  ^
  |         /
  |       /
  |     /
  |   /
  | /
  +----------------> x`;

export function buildVisualSystemPrompt() {
  return String.raw`You draw very simple text diagrams for CBSE Class 9-12 questions. The diagram is shown in a monospace font, like a code block.

OUTPUT
- Return ONLY the diagram itself. No explanation, no title, no code fences, no markdown, no Mermaid.
- Never return flowchart, graph TD, sequenceDiagram or any other Mermaid syntax.

DRAWING RULES
- Use only these characters: letters, digits, space, / \ | _ - + . : ^ v < > ( ) [ ] = ' , and the symbols degree, root, pi, omega, theta, mu.
- Never use tabs, box-drawing characters, emojis, LaTeX, $ or Unicode arrows.
- Use spaces (not tabs) for alignment. Every line must line up in a monospace font.
- At most 40 characters wide and 14 lines tall.
- Draw sides and distances with - | / \ and corners with the point letter (A, B, C ...).
- Use arrows (^ v < >) only where direction matters (force, current, motion, ray).
- Put each value next to the side or object it belongs to, once. Never repeat a label.
- Use only the labels and values given in the description. Never invent a value.
- Keep it simple and symmetric. A reader should understand it at a glance.

EXAMPLES

Triangle with sides:
${TRIANGLE_EXAMPLE}

Right-angled triangle:
${RIGHT_TRIANGLE_EXAMPLE}

Forces on a block:
${FORCES_EXAMPLE}

Graph with a straight line:
${GRAPH_EXAMPLE}`;
}

export function buildVisualUserPrompt({
  type,
  description,
  subject = "",
  className = "",
  previousResponse = "",
  validationErrors = [],
}) {
  const lines = [
    `TYPE: ${type}`,
    subject ? `SUBJECT: ${subject}` : "",
    className ? `CLASS: ${className}` : "",
    "",
    "DESCRIPTION OF THE DIAGRAM:",
    description,
    "",
    "Draw this as a simple text diagram. Return only the diagram.",
  ];

  if (previousResponse && validationErrors.length) {
    lines.push(
      "",
      "YOUR PREVIOUS ATTEMPT (it was rejected):",
      previousResponse,
      "",
      "PROBLEMS TO FIX:",
      ...validationErrors.map((issue) => `- ${issue}`),
      "",
      "Return a corrected diagram only."
    );
  }

  return lines.filter((line, i) => line !== "" || i > 0).join("\n");
}