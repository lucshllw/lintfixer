import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC_DIR = resolve(__dirname, "../src");

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("core architecture boundary (ARCH-001)", () => {
  it("contains zero Node built-in, filesystem, network, or adapter imports", () => {
    const files = collectTsFiles(CORE_SRC_DIR);
    expect(files.length).toBeGreaterThan(5);

    const forbidden = [
      /from\s+["']node:/,
      /from\s+["']fs["']/,
      /from\s+["']path["']/,
      /from\s+["']child_process["']/,
      /from\s+["']@ikigai\/adapters/,
      /from\s+["']@ikigai\/cli/,
    ];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(content, `${file} violated zero-I/O boundary with ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
