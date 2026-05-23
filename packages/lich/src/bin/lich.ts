#!/usr/bin/env bun
import { VERSION } from "../version.js";

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
  console.log(`lich ${VERSION}`);
  process.exit(0);
}

console.log(`lich ${VERSION} — not yet implemented`);
console.log(`Run 'lich --help' to see available commands.`);
process.exit(0);
