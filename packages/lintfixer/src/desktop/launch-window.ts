import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WindowLaunchResult {
  readonly launched: boolean;
  readonly mode: "app-shell" | "default-browser" | "headless-none";
  readonly browserBinary: string | null;
}

function findDesktopAppBrowser(): string | null {
  if (process.platform === "win32") {
    const candidates = [
      join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      ),
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      ),
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "BraveSoftware",
        "Brave-Browser",
        "Application",
        "brave.exe",
      ),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  const linuxCandidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
  return linuxCandidates.find((c) => existsSync(c)) ?? null;
}

function resolveShellProfileDir(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const profileDir = join(base, "LintFixer", "shell-profile");
  mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

/**
 * Opens LintFixer as an isolated external desktop application window (`--app=url`)
 * via Edge/Chrome/Chromium so there are no browser tabs or URL chrome.
 */
export function launchExternalDesktopWindow(url: string): WindowLaunchResult {
  const binary = findDesktopAppBrowser();
  if (binary) {
    const profileDir = resolveShellProfileDir();
    const args = [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=1480,920",
      "--class=LintFixer",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    const child = spawn(binary, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { launched: true, mode: "app-shell", browserBinary: binary };
  }

  // Graceful fallback to OS default URL opener if no Chromium shell is present.
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { launched: true, mode: "default-browser", browserBinary: "cmd" };
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
  child.unref();
  return { launched: true, mode: "default-browser", browserBinary: opener };
}
