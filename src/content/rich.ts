// Turns the lightly-marked-up text in the content files into safe HTML.
//   [text](https://example.com)  → link      **text**  → bold
//   a single line break          → <br>      a blank line → new paragraph
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One run of text (line breaks become <br>). */
export function rich(text: string | undefined): string {
  return esc((text ?? "").trim())
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/|#)[^)\s]*)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
}

/** Text split into paragraphs at blank lines. */
export function paragraphs(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(rich);
}
