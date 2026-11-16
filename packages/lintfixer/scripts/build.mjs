import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");
const distDir = join(pkgRoot, "dist");
const uiSrcDist = join(repoRoot, "packages/desktop-ui/dist");
const uiTargetDist = join(distDir, "ui");
const installerDir = join(repoRoot, "dist-installer");

async function main() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  // 1. Build React Desktop UI (Vite) without spawning a shell
  const viteMod = await import("vite");
  await viteMod.build({
    configFile: join(repoRoot, "packages/desktop-ui/vite.config.ts"),
    root: join(repoRoot, "packages/desktop-ui"),
  });

  // 2. Bundle CLI & Postinstall standalone (bundle workspace packages + yaml + zod cleanly so npx/exe need zero external install!)
  const sharedEsbuild = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: 'import { createRequire as __lfCreateRequire } from "node:module"; const require = __lfCreateRequire(import.meta.url);',
    },
    alias: {
      "@ikigai/core": join(repoRoot, "packages/core/src/index.ts"),
      "@ikigai/adapters": join(repoRoot, "packages/adapters/src/index.ts"),
      "@ikigai/cli": join(repoRoot, "packages/cli/src/index.ts"),
    },
  };

  await build({
    ...sharedEsbuild,
    entryPoints: [join(pkgRoot, "src/cli/main.ts")],
    outfile: join(distDir, "main.js"),
  });

  await build({
    ...sharedEsbuild,
    entryPoints: [join(pkgRoot, "src/cli/postinstall.ts")],
    outfile: join(distDir, "postinstall.js"),
  });

  // 3. Copy Desktop UI bundle, Kat-Brackets icons & DPAPI native binary into dist/
  cpSync(uiSrcDist, uiTargetDist, { recursive: true });

  const dpapiExe = join(repoRoot, "packages/adapters/native/dpapi-seal.exe");
  if (existsSync(dpapiExe)) {
    cpSync(dpapiExe, join(distDir, "dpapi-seal.exe"));
  }

  // Copy example corpora cleanly so calibration works inside standalone NPM/EXE package too.
  const examplesSrc = join(repoRoot, "examples");
  if (existsSync(examplesSrc)) {
    cpSync(examplesSrc, join(distDir, "examples"), { recursive: true });
  }

  // 4. Write lightweight README for NPM tarball
  writeFileSync(
    join(pkgRoot, "README.md"),
    `# LintFixer\n\nLinter semantico baseado em regras, Git Score, Auto-Fix verificavel, Busca GitHub e Cofre Criptografado AES-256-GCM/DPAPI com UI Rack Observatorio.\n\n\`\`\`bash\nnpx lintfixer\nlintfixer setup\nlintfixer score HEAD\nlintfixer github search owner/repo\n\`\`\`\n`,
    "utf8",
  );

  // 5. Build native Windows .exe Setup & Launcher when running on Windows with .NET Framework csc.exe
  const cscExe = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  if (process.platform === "win32" && existsSync(cscExe)) {
    mkdirSync(installerDir, { recursive: true });
    const stageApp = join(installerDir, "payload-stage");
    const payloadZip = join(installerDir, "runtime-payload.zip");
    const icoPath = join(pkgRoot, "assets/kat-brackets.ico");

    rmSync(stageApp, { recursive: true, force: true });
    rmSync(payloadZip, { force: true });
    mkdirSync(stageApp, { recursive: true });

    cpSync(join(pkgRoot, "bin"), join(stageApp, "bin"), { recursive: true });
    cpSync(distDir, join(stageApp, "dist"), { recursive: true });
    cpSync(join(pkgRoot, "assets"), join(stageApp, "assets"), { recursive: true });
    // Minimal standalone runtime package.json (type: module so main.js & .mjs work cleanly).
    writeFileSync(
      join(stageApp, "package.json"),
      JSON.stringify({ name: "lintfixer-runtime", version: "0.2.0", type: "module" }, null, 2),
      "utf8",
    );

    // Compile LintFixer.exe (Desktop App Launcher) directly into stageApp so setup installs it!
    execFileSync(
      cscExe,
      [
        "/nologo",
        "/optimize",
        "/target:winexe",
        `/win32icon:${icoPath}`,
        "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll",
        `/out:${join(stageApp, "LintFixer.exe")}`,
        join(pkgRoot, "native/LintFixerLauncher.cs"),
      ],
      { stdio: "inherit" },
    );

    // Pack stageApp into runtime-payload.zip via built-in .NET ZipFile (fast, deterministic).
    const zipPs = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory("${stageApp.replace(/\\/g, "\\\\")}", "${payloadZip.replace(/\\/g, "\\\\")}", [IO.Compression.CompressionLevel]::Optimal, $false)`;
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", zipPs],
      { stdio: "inherit", windowsHide: true },
    );

    // Compile standalone LintFixer-Setup.exe with embedded runtime-payload.zip + Kat-Brackets ICO!
    execFileSync(
      cscExe,
      [
        "/nologo",
        "/optimize",
        "/target:winexe",
        `/win32icon:${icoPath}`,
        "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.IO.Compression.dll",
        "/reference:System.IO.Compression.FileSystem.dll",
        `/resource:${payloadZip},runtime-payload.zip`,
        `/out:${join(installerDir, "LintFixer-Setup.exe")}`,
        join(pkgRoot, "native/LintFixerSetup.cs"),
      ],
      { stdio: "inherit" },
    );

    cpSync(join(stageApp, "LintFixer.exe"), join(installerDir, "LintFixer.exe"));
    rmSync(stageApp, { recursive: true, force: true });
    rmSync(payloadZip, { force: true });
  }

  console.log("LintFixer bundle build complete.");
}

await main();
