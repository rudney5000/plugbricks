import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is served by `plugbricks admin` on 127.0.0.1:4100. In development, Vite proxies the API
// and the OIDC routes to it, so the browser sees one origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      ["/api", "/auth"].map((path) => [
        path,
        {
          target: "http://127.0.0.1:4100",
          // The admin answers only requests addressed to 127.0.0.1:4100 (DNS rebinding guard), and
          // refuses an Origin from another port: the dev proxy presents itself as that origin.
          changeOrigin: true,
          headers: { origin: "http://127.0.0.1:4100" },
        },
      ]),
    ),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
