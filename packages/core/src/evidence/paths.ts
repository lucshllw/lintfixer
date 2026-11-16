export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function pathSegments(path: string): readonly string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

export function pathBasename(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? "";
}

export function fileExtension(path: string): string {
  const base = pathBasename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot);
}

export function isSafeRelativeRepoPath(path: string): boolean {
  if (path.trim() === "" || path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  const segments = normalizePath(path).split("/");
  return !segments.some((seg) => seg === "" || seg === "." || seg === "..");
}
