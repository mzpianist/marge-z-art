// Content files refer to pictures by filename (e.g. "piano.png"); the files
// live in src/assets/. The editor's photo upload saves new ones there.
import type { ImageMetadata } from "astro";

const files = import.meta.glob<{ default: ImageMetadata }>("../assets/*.{png,jpg,jpeg,webp,gif,avif}", {
  eager: true,
});

export function image(name: string | undefined): ImageMetadata | undefined {
  return name ? files[`../assets/${name}`]?.default : undefined;
}
