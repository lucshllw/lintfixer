import type { TurnFile } from "../domain/types.ts";
import { isSafeRelativeRepoPath } from "./paths.ts";
import type { DiffParseFailureReason, DiffParseResult } from "./types.ts";

const GIT_HEADER = "diff --git ";
const OLD_FILE_MARKER = "--- ";
const NEW_FILE_MARKER = "+++ ";
const DEV_NULL = "/dev/null";
const OLD_PREFIX = "a/";
const NEW_PREFIX = "b/";
const NO_NEWLINE_MARKER = "\\ ";
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const KNOWN_EXTENDED_HEADERS = [
  "old mode ",
  "new mode ",
  "deleted file mode ",
  "new file mode ",
  "similarity index ",
  "dissimilarity index ",
  "index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
] as const;

export const HUNK_MARKER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;

/**
 * Strictly splits git or plain unified diffs into validated per-file patches.
 * Rejects combined diffs, binary patches, quoted/unsafe traversal paths, renames
 * with content, and truncated hunks so incomplete evidence is never evaluated.
 */
export function parseUnifiedDiff(text: string): DiffParseResult {
  const cleanText = text.replace(/^\uFEFF/, "");
  const lines = splitLines(cleanText);
  const first = lines.stripped.findIndex((line) => line.trim() !== "");
  if (first === -1) {
    return { status: "PARSED", files: [] };
  }

  if (
    lines.stripped.some(
      (line) => line.startsWith("diff --cc ") || line.startsWith("diff --combined "),
    )
  ) {
    return invalid("COMBINED_DIFF");
  }

  const format = detectFormat(lines.stripped, first);
  if (format === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  const files: TurnFile[] = [];
  let cursor = first;

  while (cursor < lines.stripped.length) {
    const section =
      format === "GIT" ? readGitSection(lines, cursor) : readPlainSection(lines, cursor);

    if (section.status === "INVALID") {
      return section;
    }

    if (section.file !== null) {
      if (!isSafeRelativeRepoPath(section.file.path)) {
        return invalid("UNSAFE_PATH");
      }
      files.push(section.file);
    }

    cursor = section.next;
  }

  return { status: "PARSED", files };
}

interface DiffLines {
  readonly raw: readonly string[];
  readonly stripped: readonly string[];
  readonly endsWithNewline: boolean;
}

type SectionRead =
  | { readonly status: "OK"; readonly file: TurnFile | null; readonly next: number }
  | { readonly status: "INVALID"; readonly reason: DiffParseFailureReason };

function splitLines(text: string): DiffLines {
  const raw = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) {
    raw.pop();
  }
  const stripped = raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { raw, stripped, endsWithNewline };
}

function detectFormat(text: readonly string[], first: number): "GIT" | "PLAIN" | null {
  if ((text[first] ?? "").startsWith(GIT_HEADER)) {
    return "GIT";
  }
  if (text.some((line) => line.startsWith(GIT_HEADER))) {
    return null;
  }
  return isPlainStart(text, first) ? "PLAIN" : null;
}

function isPlainStart(text: readonly string[], index: number): boolean {
  return (
    (text[index] ?? "").startsWith(OLD_FILE_MARKER) &&
    (text[index + 1] ?? "").startsWith(NEW_FILE_MARKER)
  );
}

function readGitSection(lines: DiffLines, start: number): SectionRead {
  const headerLine = lines.stripped[start] ?? "";
  const rest = headerLine.slice(GIT_HEADER.length);
  if (rest.startsWith('"') || rest.includes(' "')) {
    return invalid("QUOTED_PATH");
  }
  if (!rest.startsWith(OLD_PREFIX)) {
    return invalid("UNSUPPORTED_PREFIX");
  }

  const headerPaths = splitGitHeaderPaths(rest);
  if (headerPaths === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }
  if (headerPaths.oldPath === "" || headerPaths.newPath === "") {
    return invalid("MISSING_PATH");
  }

  let cursor = start + 1;
  let movedFrom: string | null = null;
  let movedTo: string | null = null;

  while (cursor < lines.stripped.length) {
    const line = lines.stripped[cursor] ?? "";
    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      return invalid("BINARY_PATCH");
    }
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      movedFrom = line.slice(line.indexOf("from ") + 5);
    }
    if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      movedTo = line.slice(line.indexOf("to ") + 3);
    }
    if (movedFrom?.startsWith('"') || movedTo?.startsWith('"')) {
      return invalid("QUOTED_PATH");
    }
    if (!KNOWN_EXTENDED_HEADERS.some((prefix) => line.startsWith(prefix))) {
      break;
    }
    cursor += 1;
  }

  if (!(lines.stripped[cursor] ?? "").startsWith(OLD_FILE_MARKER)) {
    if (cursor >= lines.stripped.length || lines.stripped[cursor]?.startsWith(GIT_HEADER)) {
      return { status: "OK", file: null, next: cursor };
    }
    return isBlankTail(lines.stripped, cursor)
      ? { status: "OK", file: null, next: lines.stripped.length }
      : invalid("UNRECOGNIZED_DIFF");
  }

  const filePaths = readMarkerPaths(lines.stripped, cursor, "GIT");
  if ("reason" in filePaths) {
    return invalid(filePaths.reason);
  }

  if (
    (filePaths.oldPath !== null && filePaths.oldPath !== headerPaths.oldPath) ||
    (filePaths.newPath !== null && filePaths.newPath !== headerPaths.newPath)
  ) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  if (
    headerPaths.oldPath !== headerPaths.newPath ||
    (movedFrom !== null && movedTo !== null && movedFrom !== movedTo)
  ) {
    return invalid("RENAMED_PATH");
  }

  return readFileBody(
    lines,
    start,
    cursor + 2,
    filePaths.newPath ?? filePaths.oldPath ?? "",
    "GIT",
  );
}

function readPlainSection(lines: DiffLines, start: number): SectionRead {
  const filePaths = readMarkerPaths(lines.stripped, start, "PLAIN");
  if ("reason" in filePaths) {
    return invalid(filePaths.reason);
  }
  if (
    filePaths.oldPath !== null &&
    filePaths.newPath !== null &&
    filePaths.oldPath !== filePaths.newPath
  ) {
    return invalid("RENAMED_PATH");
  }

  return readFileBody(
    lines,
    start,
    start + 2,
    filePaths.newPath ?? filePaths.oldPath ?? "",
    "PLAIN",
  );
}

function readFileBody(
  lines: DiffLines,
  sectionStart: number,
  hunksStart: number,
  path: string,
  format: "GIT" | "PLAIN",
): SectionRead {
  let cursor = hunksStart;
  let hunkCount = 0;

  while (cursor < lines.stripped.length && (lines.stripped[cursor] ?? "").startsWith("@@")) {
    const hunkNext = readHunk(lines.stripped, cursor);
    if (typeof hunkNext !== "number") {
      return invalid(hunkNext.reason);
    }
    cursor = hunkNext;
    hunkCount += 1;
  }

  if (hunkCount === 0) {
    return invalid(cursor >= lines.stripped.length ? "TRUNCATED_HUNK" : "UNRECOGNIZED_DIFF");
  }

  let next: number | null = null;
  if (
    cursor >= lines.stripped.length ||
    (format === "GIT"
      ? (lines.stripped[cursor] ?? "").startsWith(GIT_HEADER)
      : isPlainStart(lines.stripped, cursor))
  ) {
    next = cursor;
  } else if (isBlankTail(lines.stripped, cursor)) {
    next = lines.stripped.length;
  }

  if (next === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  const rawBody = lines.raw
    .slice(sectionStart, cursor)
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .join("\n");
  const patch = cursor < lines.raw.length || lines.endsWithNewline ? `${rawBody}\n` : rawBody;

  return { status: "OK", file: { path, patch }, next };
}

function readHunk(
  text: readonly string[],
  at: number,
): number | { readonly reason: DiffParseFailureReason } {
  const match = HUNK_HEADER_RE.exec(text[at] ?? "");
  if (match === null) {
    return { reason: "UNRECOGNIZED_DIFF" };
  }

  let oldLeft = Number(match[2] ?? 1);
  let newLeft = Number(match[4] ?? 1);
  let cursor = at + 1;
  let afterBodyLine = false;

  while (oldLeft > 0 || newLeft > 0) {
    if (cursor >= text.length) {
      return { reason: "TRUNCATED_HUNK" };
    }

    const line = text[cursor] ?? "";
    if (line.startsWith(NO_NEWLINE_MARKER)) {
      if (!afterBodyLine) {
        return { reason: "UNRECOGNIZED_DIFF" };
      }
      afterBodyLine = false;
      cursor += 1;
      continue;
    }

    const marker = line === "" ? " " : line.charAt(0);
    const consumesOld = marker === " " || marker === "-";
    const consumesNew = marker === " " || marker === "+";
    if (
      !(consumesOld || consumesNew) ||
      (consumesOld && oldLeft === 0) ||
      (consumesNew && newLeft === 0)
    ) {
      return { reason: "UNRECOGNIZED_DIFF" };
    }

    oldLeft -= consumesOld ? 1 : 0;
    newLeft -= consumesNew ? 1 : 0;
    afterBodyLine = true;
    cursor += 1;
  }

  const closesWithMarker = afterBodyLine && (text[cursor] ?? "").startsWith(NO_NEWLINE_MARKER);
  return closesWithMarker ? cursor + 1 : cursor;
}

function splitGitHeaderPaths(rest: string): { oldPath: string; newPath: string } | null {
  const separator = ` ${NEW_PREFIX}`;
  const pathLength = (rest.length - OLD_PREFIX.length - separator.length) / 2;
  if (Number.isInteger(pathLength) && pathLength > 0) {
    const oldPath = rest.slice(OLD_PREFIX.length, OLD_PREFIX.length + pathLength);
    if (rest.slice(OLD_PREFIX.length + pathLength) === `${separator}${oldPath}`) {
      return { oldPath, newPath: oldPath };
    }
  }
  const index = rest.indexOf(separator, OLD_PREFIX.length);
  if (index === -1) {
    return null;
  }
  return {
    oldPath: rest.slice(OLD_PREFIX.length, index),
    newPath: rest.slice(index + separator.length),
  };
}

function readMarkerPaths(
  text: readonly string[],
  index: number,
  format: "GIT" | "PLAIN",
):
  | { readonly oldPath: string | null; readonly newPath: string | null }
  | { readonly reason: DiffParseFailureReason } {
  const oldLine = text[index] ?? "";
  const newLine = text[index + 1] ?? "";
  if (!oldLine.startsWith(OLD_FILE_MARKER) || !newLine.startsWith(NEW_FILE_MARKER)) {
    return { reason: "UNRECOGNIZED_DIFF" };
  }

  const oldRaw = cutAtTab(oldLine.slice(OLD_FILE_MARKER.length));
  const newRaw = cutAtTab(newLine.slice(NEW_FILE_MARKER.length));
  if (oldRaw.startsWith('"') || newRaw.startsWith('"')) {
    return { reason: "QUOTED_PATH" };
  }

  const hasOld = oldRaw.startsWith(OLD_PREFIX);
  const hasNew = newRaw.startsWith(NEW_PREFIX);
  let oldStripped: string;
  let newStripped: string;

  if ((hasOld || oldRaw === DEV_NULL) && (hasNew || newRaw === DEV_NULL)) {
    oldStripped = hasOld ? oldRaw.slice(OLD_PREFIX.length) : oldRaw;
    newStripped = hasNew ? newRaw.slice(NEW_PREFIX.length) : newRaw;
  } else if (format === "PLAIN" && !hasOld && !hasNew) {
    oldStripped = oldRaw;
    newStripped = newRaw;
  } else {
    return { reason: "UNSUPPORTED_PREFIX" };
  }

  if (
    (oldStripped === "" || oldStripped === DEV_NULL) &&
    (newStripped === "" || newStripped === DEV_NULL)
  ) {
    return { reason: "MISSING_PATH" };
  }

  const oldPath = oldStripped === DEV_NULL ? null : oldStripped;
  const newPath = newStripped === DEV_NULL ? null : newStripped;
  if (oldPath === "" || newPath === "") {
    return { reason: "MISSING_PATH" };
  }
  return { oldPath, newPath };
}

function cutAtTab(value: string): string {
  const tab = value.indexOf("\t");
  return tab === -1 ? value : value.slice(0, tab);
}

function isBlankTail(text: readonly string[], from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    if ((text[i] ?? "").trim() !== "") {
      return false;
    }
  }
  return true;
}

function invalid(reason: DiffParseFailureReason): {
  status: "INVALID";
  reason: DiffParseFailureReason;
} {
  return { status: "INVALID", reason };
}
