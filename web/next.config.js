import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

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
  devIndicators: false,
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
  typescript: {
    // ⚠️ Allows production builds to succeed even with TS errors
    ignoreBuildErrors: true,
	},
	eslint: {
     ignoreDuringBuilds: true,
   },
};

export default config;
