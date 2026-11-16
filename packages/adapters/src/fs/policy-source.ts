import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicySourcePort } from "@ikigai/core";

export function createFsPolicySource(repoRoot: string): PolicySourcePort {
  const readFirstExisting = (candidates: readonly string[]): string | null => {
    for (const relPath of candidates) {
      const fullPath = join(repoRoot, relPath);
      if (!existsSync(fullPath)) {
        continue;
      }
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return null;
      }
      return readFileSync(fullPath, "utf8");
    }
    return null;
  };

  return {
    async readRules(): Promise<string | null> {
      return readFirstExisting([".ikigai/rules.md", ".jev/rules.md"]);
    },
    async readConfig(): Promise<string | null> {
      return readFirstExisting([".ikigai/config.yaml", ".jev/config.yaml"]);
    },
  };
}
