import { parseArgs } from "node:util";
import type { ProviderPort } from "@ikigai/core";
import {
  handleCalibrate,
  handleCheck,
  handleCommitLint,
  handleInit,
  handleInstallGitHooks,
  handleLogin,
  handlePrReview,
  handleReportAndFeedback,
} from "./commands.ts";
import { runDoctor } from "./doctor.ts";
import type { CliIo } from "./types.ts";

const HELP_TEXT = `ikigai — Semantic linter, verified auto-fixer, commit guard & PR bot

Usage:
  ikigai doctor [--json]
  ikigai init [--from-jev] [--force] [--json]
  ikigai login --provider <openai|gemini|claude|github> [--json]   (reads secret from stdin)
  ikigai check [--diff <file|->] [--staged] [--range <base..head>] [--task <text>] [--rule <id>] [--fix] [--apply] [--verify-cmd <cmd>] [--allow-unsafe-fix-targets] [--json]
  ikigai commit-lint [--msg-file <file>] [--msg <text>] [--json]
  ikigai calibrate --corpus <path> [--repeats 3] [--threshold 0.7] [--json]
  ikigai pr review --repo <owner/name> --pr <number> [--dry-run] [--fix] [--json]
  ikigai report [--json]
  ikigai feedback [<index> <right|wrong>] [--json]
  ikigai hooks install [--json]
`;

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  providerOverride?: ProviderPort,
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === "doctor") {
    const parsed = parseArgs({
      args: [...rest],
      options: { json: { type: "boolean", default: false } },
    });
    const report = await runDoctor(io.cwd, io.env);
    io.stdout(
      parsed.values.json
        ? JSON.stringify(report, null, 2)
        : report.checks.map((c) => `[${c.status}] ${c.name}: ${c.detail}`).join("\n"),
    );
    return report.ok ? 0 : 1;
  }

  if (command === "init") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        "from-jev": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    return handleInit(io, {
      fromJev: parsed.values["from-jev"],
      force: parsed.values.force,
      json: parsed.values.json,
    });
  }

  if (command === "login") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        provider: { type: "string", default: "openai" },
        json: { type: "boolean", default: false },
      },
    });
    return handleLogin(io, {
      provider: parsed.values.provider,
      json: parsed.values.json,
    });
  }

  if (command === "check") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        diff: { type: "string" },
        staged: { type: "boolean", default: false },
        range: { type: "string" },
        task: { type: "string", default: "Evaluate repository change against policy rules." },
        rule: { type: "string", multiple: true },
        fix: { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        "verify-cmd": { type: "string" },
        "allow-unsafe-fix-targets": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    return handleCheck(io, {
      ...(parsed.values.diff ? { diffPath: parsed.values.diff } : {}),
      staged: parsed.values.staged,
      ...(parsed.values.range ? { range: parsed.values.range } : {}),
      task: parsed.values.task,
      ...(parsed.values.rule ? { ruleFilter: parsed.values.rule } : {}),
      fix: parsed.values.fix,
      apply: parsed.values.apply,
      ...(parsed.values["verify-cmd"] ? { verifyCmd: parsed.values["verify-cmd"] } : {}),
      allowProtectedOverride: parsed.values["allow-unsafe-fix-targets"],
      json: parsed.values.json,
      ...(providerOverride ? { providerOverride } : {}),
    });
  }

  if (command === "commit-lint") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        msg: { type: "string" },
        "msg-file": { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    return handleCommitLint(io, {
      ...(parsed.values.msg ? { msg: parsed.values.msg } : {}),
      ...(parsed.values["msg-file"] ? { msgFile: parsed.values["msg-file"] } : {}),
      json: parsed.values.json,
      ...(providerOverride ? { providerOverride } : {}),
    });
  }

  if (command === "calibrate") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        corpus: { type: "string" },
        repeats: { type: "string", default: "3" },
        threshold: { type: "string", default: "0.7" },
        provider: { type: "string" },
        model: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    if (!parsed.values.corpus) {
      io.stderr("Missing --corpus <path>");
      return 2;
    }
    return handleCalibrate(io, {
      corpusPath: parsed.values.corpus,
      repeats: Number(parsed.values.repeats) || 3,
      threshold: Number(parsed.values.threshold) || 0.7,
      ...(parsed.values.provider ? { providerName: parsed.values.provider } : {}),
      ...(parsed.values.model ? { modelName: parsed.values.model } : {}),
      json: parsed.values.json,
      ...(providerOverride ? { providerOverride } : {}),
    });
  }

  if (command === "pr" && rest[0] === "review") {
    const parsed = parseArgs({
      args: [...rest.slice(1)],
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    const prNumber = Number(parsed.values.pr);
    if (!parsed.values.repo || !Number.isInteger(prNumber) || prNumber <= 0) {
      io.stderr("Expected --repo <owner/name> --pr <number>");
      return 2;
    }
    return handlePrReview(io, {
      repo: parsed.values.repo,
      prNumber,
      dryRun: parsed.values["dry-run"],
      fix: parsed.values.fix,
      json: parsed.values.json,
      ...(providerOverride ? { providerOverride } : {}),
    });
  }

  if (command === "report") {
    const parsed = parseArgs({
      args: [...rest],
      options: { json: { type: "boolean", default: false } },
    });
    return handleReportAndFeedback(io, { action: "report", json: parsed.values.json });
  }

  if (command === "feedback") {
    const parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: { json: { type: "boolean", default: false } },
    });
    const idx = parsed.positionals[0] ? Number(parsed.positionals[0]) : undefined;
    const dec = parsed.positionals[1];
    return handleReportAndFeedback(io, {
      action: "feedback",
      ...(idx !== undefined && Number.isInteger(idx) ? { index: idx } : {}),
      ...(dec === "right" || dec === "wrong" ? { decision: dec } : {}),
      json: parsed.values.json,
    });
  }

  if (command === "hooks" && rest[0] === "install") {
    const parsed = parseArgs({
      args: [...rest.slice(1)],
      options: { json: { type: "boolean", default: false } },
    });
    return handleInstallGitHooks(io, { json: parsed.values.json });
  }

  io.stderr(`Unknown command: ${command}\n\n${HELP_TEXT}`);
  return 2;
}
