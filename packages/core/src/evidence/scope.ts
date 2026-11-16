import type { RuleScope } from "../domain/types.ts";
import { normalizePath } from "./paths.ts";

export function matchesScope(path: string, scope: string): boolean {
  return globToRegExp(scope).test(normalizePath(path));
}

export function matchesRuleScope(path: string, scope: RuleScope): boolean {
  const normalized = normalizePath(path);
  if (!scope.include.some((pattern) => globToRegExp(pattern).test(normalized))) {
    return false;
  }
  return !scope.exclude.some((pattern) => globToRegExp(pattern).test(normalized));
}

function globToRegExp(glob: string): RegExp {
  const source = normalizePath(glob);
  let pattern = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";

    if (char === "*") {
      if (source[index + 1] === "*") {
        const followedBySlash = source[index + 2] === "/";
        pattern += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${pattern}$`);
}
