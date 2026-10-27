// Generate the publishable dist/package.json and copy README/LICENSE into dist.
//
// Why this exists: pnpm's `publishConfig.directory` only packs the given directory.
// It does not write a manifest for you, and it does not copy README/LICENSE from the
// package root, which is what the registry expects for the package page.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

const published = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  keywords: manifest.keywords,
  license: manifest.license,
  repository: manifest.repository,
  engines: manifest.engines,
  type: "module",
  // No side effects, so consumers can tree-shake.
  sideEffects: false,
  // Kept for tooling that still reads main/types instead of exports.
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    ".": { types: "./index.d.ts", default: "./index.js" },
    "./vue": { types: "./vue.d.ts", default: "./vue.js" },
    "./multi-tab": { types: "./multi-tab.d.ts", default: "./multi-tab.js" },
  },
  peerDependencies: manifest.peerDependencies,
  peerDependenciesMeta: manifest.peerDependenciesMeta,
  // Ship the publish target inside the packed manifest: the workspace .npmrc points
  // at a private registry and would otherwise override it.
  publishConfig: {
    registry: "https://registry.npmjs.org/",
    access: "public",
  },
};

writeFileSync(resolve(packageRoot, "dist/package.json"), `${JSON.stringify(published, null, 2)}\n`);

for (const file of ["README.md", "LICENSE"]) {
  const source = resolve(packageRoot, file);
  if (existsSync(source)) {
    copyFileSync(source, resolve(packageRoot, "dist", file));
  }
}

console.log("[sse-client] dist/package.json generated; README and LICENSE copied");
