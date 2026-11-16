// The colour pairs the site rotates through: a solid background plus one
// contrasting text colour. They live in palettes.json — edit them with the
// local editor, which refuses pairs under 4.5:1 contrast (WCAG AA).
// Order matters: neighbours should feel different.
import data from "./palettes.json";

export const palettes: [bg: string, fg: string][] = data.map((p) => [p.bg, p.fg]);
