// @ts-check
// prebuild setup script — runs before `next build`
// Uses CommonJS (no "type":"module" applies here since this is run directly by node)
const fs = require("fs");
const path = require("path");

// ── 1. Copy mapbox-gl.css to public/ ─────────────────────────────────────────
// mapbox-gl is hoisted to the monorepo root by npm workspaces, so its CSS
// lives outside the `web/` directory. Next.js's webpack CSS pipeline cannot
// process files from parent directories, so we serve it as a static file
// instead (referenced via <link> in layout.tsx).
const mapboxCssSrc = require.resolve("mapbox-gl/dist/mapbox-gl.css");
fs.copyFileSync(mapboxCssSrc, path.resolve(__dirname, "../public/mapbox-gl.css"));
console.log("✓ Copied mapbox-gl.css to public/");

// ── 2. Copy lightningcss native binary on Linux ───────────────────────────────
// lightningcss loads its compiled .node binary via a relative path:
//   require('../lightningcss.linux-x64-gnu.node')
// ...meaning it expects the file at <lightningcss-pkg-dir>/lightningcss.linux-x64-gnu.node
//
// But npm installs the binary in a SEPARATE optional package:
//   lightningcss-linux-x64-gnu/lightningcss.linux-x64-gnu.node
//
// So we copy it into place manually before the build.
// 📖 Learn: npm "optional dependencies" and NAPI-RS platform packages
if (process.platform === "linux") {
  try {
    const lightningcssDir = path.dirname(
      require.resolve("lightningcss/package.json")
    );
    // lightningcss tries to load the binary from one directory UP from node/index.js,
    // which is the package root itself
    const binaryName = "lightningcss.linux-x64-gnu.node";
    const dest = path.join(lightningcssDir, binaryName);

    if (!fs.existsSync(dest)) {
      const platformPkgDir = path.dirname(
        require.resolve("lightningcss-linux-x64-gnu/package.json")
      );
      const src = path.join(platformPkgDir, binaryName);

      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log("✓ Copied lightningcss Linux binary into lightningcss package dir");
      } else {
        console.warn("⚠ lightningcss binary not found at:", src);
        console.warn("  Tailwind CSS compilation may fail.");
      }
    } else {
      console.log("✓ lightningcss Linux binary already in place");
    }
  } catch (e) {
    console.warn("⚠ Could not copy lightningcss binary:", e.message);
    console.warn("  Tailwind CSS compilation may fail.");
  }
}
