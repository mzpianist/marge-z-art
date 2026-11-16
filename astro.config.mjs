import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://www.margezart.com",
  trailingSlash: "ignore",
  // Keep the spaces between words and inline links exactly as written.
  compressHTML: false,
  integrations: [sitemap()],
  redirects: {
    // The old Git page only linked to mood-lighting; it now lives under Other Projects.
    "/things-i-do/git": "/things-i-do/other-projects",
    "/home": "/",
  },
});
