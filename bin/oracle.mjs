#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx so `npx oracle` works from a clone.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const res = spawnSync(tsx, [path.join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
