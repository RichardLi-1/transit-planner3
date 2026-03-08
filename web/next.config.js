import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvConfig } from "@next/env";

/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Load .env from repo root (one level above /web) before validating env schema
loadEnvConfig(projectRoot);

await import("./src/env.js");

/** @type {import("next").NextConfig} */
const config = {
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
};

export default config;
