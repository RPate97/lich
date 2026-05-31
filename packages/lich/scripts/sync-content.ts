import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { resolve, join, relative, dirname } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SOURCE_DIR = join(ROOT, "docs/content");

interface TargetSpec {
  dir: string;
  map: (relSource: string) => string | null;
}

function isGeneratedSnippet(rel: string): boolean {
  return rel.split("/").includes("_generated");
}

const TARGETS: TargetSpec[] = [
  {
    dir: join(ROOT, "docs/site/reference"),
    map: (rel) => {
      if (isGeneratedSnippet(rel)) return null;
      return rel.startsWith("reference/") ? rel.slice("reference/".length) : null;
    },
  },
  {
    dir: join(ROOT, "docs/site/recipes"),
    map: (rel) => {
      if (isGeneratedSnippet(rel)) return null;
      if (!rel.startsWith("recipes/")) return null;
      const sub = rel.slice("recipes/".length);
      if (sub === "index.md") return null;
      return sub;
    },
  },
  {
    dir: join(ROOT, "skills/lich-instrument/references"),
    map: (rel) => {
      if (isGeneratedSnippet(rel)) return null;
      if (rel.startsWith("reference/") || rel.startsWith("recipes/")) {
        return rel.split("/").slice(1).join("/");
      }
      return rel;
    },
  },
];

const INCLUDE_RE = /<!--\s*@include:\s*([^\s#]+)(?:#(\S+?))?\s*-->/g;

export function expandIncludes(content: string, sourceFile: string): string {
  return content.replace(INCLUDE_RE, (_full, refPath: string, anchor: string | undefined) => {
    const includePath = resolve(dirname(sourceFile), refPath);
    if (!existsSync(includePath)) {
      throw new Error(`Include not found: ${includePath} (referenced from ${sourceFile})`);
    }
    const includeContent = readFileSync(includePath, "utf8");
    if (!anchor) return includeContent;
    return extractSection(includeContent, anchor, includePath);
  });
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractSection(content: string, anchor: string, filePath: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((line) => {
    const m = line.match(/^(#+)\s+(.+?)(?:\s+\{#[^}]+\})?\s*$/);
    if (!m) return false;
    const explicitId = line.match(/\{#([^}]+)\}/);
    const slug = explicitId ? explicitId[1] : slugify(m[2]);
    return slug.toLowerCase() === anchor.toLowerCase();
  });
  if (startIdx === -1) {
    throw new Error(`Section #${anchor} not found in ${filePath}`);
  }
  const startLevel = (lines[startIdx].match(/^#+/) ?? [""])[0].length;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n").trim();
}

function walkContent(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkContent(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function main(): void {
  let changed = 0;
  let checked = 0;
  for (const source of walkContent(SOURCE_DIR)) {
    const rel = relative(SOURCE_DIR, source);
    const raw = readFileSync(source, "utf8");
    const expanded = expandIncludes(raw, source);
    for (const target of TARGETS) {
      const sub = target.map(rel);
      if (sub === null) continue;
      const dest = join(target.dir, sub);
      checked++;
      const existing = existsSync(dest) ? readFileSync(dest, "utf8") : null;
      if (existing === expanded) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, expanded);
      console.log(`sync-content: wrote ${relative(ROOT, dest)}`);
      changed++;
    }
  }
  console.log(`sync-content: done (${changed} of ${checked} files updated)`);
}

if (import.meta.main) main();
