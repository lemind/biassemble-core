// Post-build script: adds .js extensions to relative imports in dist/
// Required because tsc with moduleResolution: "bundler" doesn't add them,
// but Node.js ESM requires explicit extensions.

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative, dirname, extname } from "path";

const distDir = new URL("../dist", import.meta.url).pathname;

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      fixFile(full);
    }
  }
}

function fixFile(filePath) {
  let content = readFileSync(filePath, "utf-8");
  const original = content;

  // Fix: from "./foo" -> "./foo.js" and from "../bar" -> "../bar.js"
  // But NOT for external packages (no starting with . or /)
  content = content.replace(
    /(from\s+["'])(\.\.?\/[^"']*?)(["'])/g,
    (match, prefix, path, suffix) => {
      // Skip if already has .js or .mjs extension
      if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".json") || path.endsWith(".node")) {
        return match;
      }
      return `${prefix}${path}.js${suffix}`;
    }
  );

  // Also fix dynamic imports: import("./foo") -> import("./foo.js")
  content = content.replace(
    /(import\s*\(\s*["'])(\.\.?\/[^"']*?)(["']\s*\))/g,
    (match, prefix, path, suffix) => {
      if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".json") || path.endsWith(".node")) {
        return match;
      }
      return `${prefix}${path}.js${suffix}`;
    }
  );

  if (content !== original) {
    writeFileSync(filePath, content, "utf-8");
    console.log(`  Fixed imports in: ${relative(distDir, filePath)}`);
  }
}

console.log("Adding .js extensions to relative imports in dist/...");
walk(distDir);
console.log("Done.");
