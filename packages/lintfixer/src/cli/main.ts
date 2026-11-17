import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import {
  createEncryptedVault,
  createGitHubExplorerClient,
  findRepoRoot,
  getLocalCommitTurn,
  migrateLegacyCredentialsToVault,
  resolveGitHubToken,
  type VaultNamespace,
} from "@ikigai/adapters";
import { runCli } from "@ikigai/cli";
import { computeGitScore, DEFAULT_POLICY_CONFIG, parseRules } from "@ikigai/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runAnimatedKatIntro } from "./kat-ansi.ts";
import { launchExternalDesktopWindow } from "../desktop/launch-window.ts";
import { startLintFixerDaemon } from "../server/daemon.ts";

const HELP = `LintFixer v0.2.0 — Semantic Linter, Git Score, Auto-Fix & Cofre DPAPI (Kat-Brackets)

Usage:
  lintfixer [ui] [--setup] [--port <n>] [--no-open] [--no-anim]
  lintfixer setup [--no-open] [--no-anim]
  lintfixer score [<sha|HEAD>] [--json]
  lintfixer github search <query> [--json]
  lintfixer vault status [--json]
  lintfixer vault set <namespace>              (reads secret from stdin)
  lintfixer vault migrate [--json]
  lintfixer check | commit-lint | calibrate | init | doctor | hooks | pr ...
`;

export async function runLintFixerCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(HELP);
    return 0;
  }

  const first = argv[0];
  const isUiOrSetup =
    first === undefined || first.startsWith("-") || first === "ui" || first === "setup";

  if (isUiOrSetup) {
    const rest = first === "ui" || first === "setup" ? argv.slice(1) : argv;
    const parsed = parseArgs({
      args: [...rest],
      options: {
        setup: { type: "boolean", default: first === "setup" },
        port: { type: "string", default: "0" },
        "no-open": { type: "boolean", default: false },
        "no-anim": { type: "boolean", default: false },
      },
      allowPositionals: true,
    });

    const requestedPort = Number(parsed.values.port) || 0;
    const setupQuery = parsed.values.setup ? "&setup=1" : "";

    let daemonUrl = "";
    let closeDaemon: (() => Promise<void>) | null = null;

    await runAnimatedKatIntro({
      title: parsed.values.setup ? "Setup & Rack Observatório" : "Rack Observatório",
      noAnim: parsed.values["no-anim"],
      steps: [
        {
          label: "Cofre AES-256-GCM + OS Keystore",
          action: () => {
            const vault = createEncryptedVault();
            return vault.protection;
          },
        },
        {
          label: "Servidor Loopback 127.0.0.1",
          action: async () => {
            const daemon = await startLintFixerDaemon({
              cwd: process.cwd(),
              port: requestedPort,
            });
            daemonUrl = `${daemon.url}${setupQuery}`;
            closeDaemon = daemon.close;
            return `porta ${daemon.port}`;
          },
        },
        {
          label: parsed.values["no-open"]
            ? "Modo headless pronto"
            : "Abrindo janela externa Kat-Brackets",
          action: () => {
            if (parsed.values["no-open"]) {
              return daemonUrl;
            }
            const win = launchExternalDesktopWindow(daemonUrl);
            return win.mode;
          },
        },
      ],
    });

    stdout.write(
      `LintFixer ativo em: ${daemonUrl}\nPressione Ctrl+C para encerrar o daemon local.\n`,
    );

    await new Promise<void>((resolveWait) => {
      const shutdown = async () => {
        if (closeDaemon) {
          await closeDaemon();
        }
        resolveWait();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
    return 0;
  }

  if (first === "score") {
    const parsed = parseArgs({
      args: argv.slice(1),
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const sha = parsed.positionals[0] ?? "HEAD";
    const repoRoot = await findRepoRoot(process.cwd());
    if (!repoRoot) {
      console.error("Nao encontrado repositorio Git local.");
      return 2;
    }
    let bundle: Awaited<ReturnType<typeof getLocalCommitTurn>>;
    try {
      bundle = await getLocalCommitTurn(repoRoot, sha);
    } catch {
      const msg = "Repositorio sem commits na branch atual (ou SHA nao encontrado).";
      if (parsed.values.json) {
        stdout.write(
          `${JSON.stringify({ ok: false, error: "NO_COMMITS_YET", message: msg }, null, 2)}\n`,
        );
      } else {
        stdout.write(`${msg}\n`);
      }
      return 0;
    }
    const rulesPath = join(repoRoot, ".ikigai", "rules.md");
    const rules = existsSync(rulesPath)
      ? parseRules(readFileSync(rulesPath, "utf8")).flatMap((r) =>
          r.status === "PARSED" ? [r.rule] : [],
        )
      : [];
    const score = computeGitScore({
      commitMessage: bundle.turn.task,
      files: bundle.turn.files,
      rules,
    });
    if (parsed.values.json) {
      stdout.write(`${JSON.stringify({ commit: bundle.commit, gitScore: score }, null, 2)}\n`);
    } else {
      stdout.write(
        `Git Score ${bundle.commit.shortSha}: ${score.score}/100 (Grade ${score.grade}) · Filtro ${score.filter.inScopeCount}/${score.filter.totalFiles} arquivos\n`,
      );
      for (const f of score.factors) {
        stdout.write(`  - [${f.outcome.toUpperCase()}] ${f.label} (${f.delta})\n`);
      }
    }
    return 0;
  }

  if (first === "github" && argv[1] === "search") {
    const parsed = parseArgs({
      args: argv.slice(2),
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const query = parsed.positionals.join(" ").trim();
    if (!query) {
      console.error("Informe uma query de busca: lintfixer github search <termo>");
      return 2;
    }
    const token = await resolveGitHubToken(process.env);
    const gh = createGitHubExplorerClient(token);
    const repos = await gh.searchRepositories(query);
    if (parsed.values.json) {
      stdout.write(`${JSON.stringify({ ok: true, repos }, null, 2)}\n`);
    } else {
      for (const r of repos) {
        stdout.write(`${r.fullName} (★ ${r.stars}) · ${r.language ?? "Multi"}\n`);
      }
    }
    return 0;
  }

  if (first === "vault") {
    const sub = argv[1] ?? "status";
    const parsed = parseArgs({
      args: argv.slice(2),
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const vault = createEncryptedVault();

    if (sub === "migrate") {
      const res = migrateLegacyCredentialsToVault();
      stdout.write(
        parsed.values.json
          ? `${JSON.stringify(res, null, 2)}\n`
          : `Migradas ${res.migratedCount} credencial(is) para ${res.vaultDir}\n`,
      );
      return 0;
    }

    if (sub === "set") {
      const ns = parsed.positionals[0] as VaultNamespace | undefined;
      if (!ns) {
        console.error(
          "Uso: echo <SECRET> | lintfixer vault set <llm.jev|llm.gemini|llm.openai|llm.claude|github.oauth|github.pat>",
        );
        return 2;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const secret = Buffer.concat(chunks).toString("utf8").trim();
      vault.setSecret(ns, secret);
      stdout.write(`Segredo ${ns} selado com AES-256-GCM + ${vault.protection}.\n`);
      return 0;
    }

    const entries = vault.listMetadata();
    if (parsed.values.json) {
      stdout.write(
        `${JSON.stringify({ vaultDir: vault.vaultDir, protection: vault.protection, entries }, null, 2)}\n`,
      );
    } else {
      stdout.write(`Cofre LintFixer (${vault.protection}): ${vault.vaultDir}\n`);
      for (const e of entries) {
        stdout.write(
          `  - ${e.namespace}: ${e.status}${e.maskedPreview ? ` (${e.maskedPreview})` : ""}\n`,
        );
      }
    }
    return 0;
  }

  // Delegate standard CLI commands (`check`, `commit-lint`, `calibrate`, `doctor`, `hooks`, `pr`, `init`) to @ikigai/cli
  const readStdinText = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  void DEFAULT_POLICY_CONFIG;
  return runCli(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdinText: readStdinText,
    stdout: (text) => stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
}
