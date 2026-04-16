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
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' https://fonts.gstatic.com data:",
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${isDev ? " https:" : ""}`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://cdn.jsdelivr.net`,
  "connect-src 'self' https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com https://fonts.googleapis.com https://fonts.gstatic.com",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const config = {
  // Tell Vercel's build adapter where the monorepo root is.
  // Without this, onBuildComplete can't find next.config.js and receives
  // undefined paths, causing: "The path argument must be of type string."
  outputFileTracingRoot: projectRoot,

  // npm workspaces hoists mapbox-gl to the monorepo root's node_modules
  // (one directory above web/). Next.js's CSS rules normally restrict
  // processing to within the project directory. transpilePackages tells
  // Next.js to run these packages through the full webpack pipeline,
  // which handles cross-directory paths correctly.
  transpilePackages: ["mapbox-gl", "@mapbox/mapbox-gl-draw"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "s.gravatar.com" },
    ],
  },
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
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: csp.replace(/\s{2,}/g, " ").trim(),
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-site" },
        ],
      },
    ];
  },
};

export default config;
