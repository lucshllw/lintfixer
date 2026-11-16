import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isSafeRelativeRepoPath, type PatchApplierPort } from "@ikigai/core";

/**
 * Safe filesystem patch applier confining every path strictly inside canonical `repoRoot`,
 * rejecting symlinks and creating exact pre-write snapshots for automatic rollback.
 */
export function createSafePatchApplier(repoRoot: string): PatchApplierPort {
  const canonicalRoot = realpathSync(resolve(repoRoot));

  const resolveSafeExistingFile = (relPath: string): string | null => {
    if (!isSafeRelativeRepoPath(relPath)) {
      return null;
    }
    const candidate = resolve(canonicalRoot, relPath);
    if (!existsSync(candidate)) {
      return null;
    }
    const lstat = lstatSync(candidate);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return null;
    }
    const canonical = realpathSync(candidate);
    const inside =
      canonical === canonicalRoot ||
      canonical.toLowerCase().startsWith(`${canonicalRoot.toLowerCase()}${sep}`);
    return inside ? canonical : null;
  };

  return {
    async readTargetFiles(paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
      const result = new Map<string, string>();
      for (const relPath of paths) {
        const safePath = resolveSafeExistingFile(relPath);
        if (safePath !== null) {
          result.set(relPath, readFileSync(safePath, "utf8"));
        }
      }
      return result;
    },

    async applyValidatedPatch(
      updatedFiles: ReadonlyMap<string, string>,
    ): Promise<{ readonly rollback: () => Promise<void> }> {
      const snapshots = new Map<string, string>();

      for (const [relPath, updatedContent] of updatedFiles) {
        const safePath = resolveSafeExistingFile(relPath);
        if (safePath === null) {
          throw new Error(`Unsafe or missing target path: ${relPath}`);
        }
        snapshots.set(safePath, readFileSync(safePath, "utf8"));
        writeFileSync(safePath, updatedContent, "utf8");
      }

      return {
        async rollback(): Promise<void> {
          for (const [safePath, original] of snapshots) {
            writeFileSync(safePath, original, "utf8");
          }
        },
      };
    },
  };
}
