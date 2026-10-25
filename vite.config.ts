/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import process from "node:process";
import { defineConfig } from "vite";
import { esmFetch } from "./tools/esm_fetch.ts";

// Desktop serves the page at /apps/<name>/, so every URL in the build is relative ("./").
const desktop = "http://127.0.0.1:5555";
// `deno task serve` port (API_PORT=… when 8787 is taken)
const backend = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;
const imports: Record<string, string> =
  JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8")).imports;
// dimos-react: its TypeScript source at its tag on GitHub (deno.json's URLs, the same files deno reads), fetched and
// compiled into the page; its react, react-dom and three resolve to this page's own
const dimosReact = Object.fromEntries(
  Object.entries(imports).filter(([name]) => name.startsWith("dimos-react")),
);

export default defineConfig({
  base: "./",
  // dimos-react's source is fetched at build (tools/esm_fetch.ts)
  plugins: [esmFetch(dimosReact), react()],
  server: {
    // `deno task dev` (:5173) next to `deno task serve` (:8787) and a running Desktop (:5555)
    proxy: {
      "/api": backend,
      "/files": backend,
      "/theme.css": desktop,
      "/shell": desktop,
      "/gateways": desktop,
      "/apps": desktop,
      "/zenoh-gateway": { target: desktop, ws: true },
    },
  },
  build: {
    target: "es2022",
  },
  test: {
    // UI tests (.test.tsx) opt into happy-dom per file via @vitest-environment; the rest stay on node.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Vitest's default forks pool needs Node child-process IPC, which Deno does not emulate reliably.
    pool: "threads",
  },
});
