// Site-wide settings. The values live in site.json — edit them with the local
// editor (`npm run editor`). The menu is fixed here because it mirrors the
// pages that exist in src/pages/.
import data from "./site.json";

export const site = data;

export const nav = [
  { label: "About", href: "/about-me" },
  { label: "Art", href: "/things-i-do/art" },
  { label: "Music", href: "/things-i-do/music" },
  { label: "Projects", href: "/things-i-do/other-projects" },
  { label: "Shop", href: "/shop" },
  { label: "Contact", href: "/contact" },
];
