import { stdout } from "node:process";

const BONE = "\x1b[38;2;236;239;244m";
const EMERALD = "\x1b[38;2;34;197;139m";
const ORANGE = "\x1b[38;2;234;108;43m";
const MUTED = "\x1b[38;2;139;149;165m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export interface AnimatedStep {
  readonly label: string;
  readonly action?: () => Promise<string | undefined> | string | undefined;
}

const FRAMES = [
  { braceL: "{", eyes: "_ _", braceR: "}" },
  { braceL: " {", eyes: "_ _", braceR: "} " },
  { braceL: "{", eyes: "- -", braceR: "}" },
  { braceL: "{", eyes: "_ _", braceR: "}" },
];

export function canAnimateTerminal(
  noAnimFlag = false,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (noAnimFlag) return false;
  if (env.CI === "true" || env.CI === "1" || env.TERM === "dumb") return false;
  return Boolean(stdout.isTTY);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderBar(ratio: number, width = 26): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const done = "█".repeat(filled);
  const rest = "░".repeat(width - filled);
  return `${EMERALD}${done}${MUTED}${rest}${RESET}`;
}

export async function runAnimatedKatIntro(opts: {
  readonly title: string;
  readonly steps: readonly AnimatedStep[];
  readonly noAnim?: boolean;
}): Promise<void> {
  const animated = canAnimateTerminal(opts.noAnim);

  if (!animated) {
    stdout.write(`LintFixer :: ${opts.title}\n`);
    for (const step of opts.steps) {
      const detail = (await step.action?.()) ?? "OK";
      stdout.write(`  [OK] ${step.label}${detail ? ` (${detail})` : ""}\n`);
    }
    return;
  }

  const total = Math.max(1, opts.steps.length);
  const completedLines: string[] = [];
  let printedLines = 0;

  const paint = (frameIdx: number, activeLabel: string, ratio: number) => {
    const f = FRAMES[frameIdx % FRAMES.length] ?? FRAMES[0];
    if (printedLines > 0) {
      stdout.write(`\x1b[${printedLines}A`);
    }
    const lines = [
      `${BONE}${BOLD}   /\\_/\\     LintFixer ${MUTED}· ${opts.title}${RESET}`,
      `${BONE}  ${f?.braceL} (${f?.eyes}) ${f?.braceR}  ${renderBar(ratio)} ${MUTED}${Math.round(ratio * 100)}%${RESET}`,
      `${BONE}    > ^ <    ${MUTED}${activeLabel}${RESET}`,
      ...completedLines.slice(-4),
    ];

    for (const line of lines) {
      stdout.write(`\x1b[2K${line}\n`);
    }
    printedLines = lines.length;
  };

  let frameCounter = 0;
  for (let i = 0; i < opts.steps.length; i += 1) {
    const step = opts.steps[i];
    if (!step) continue;

    paint(frameCounter++, step.label, i / total);
    const timer = setInterval(() => {
      paint(frameCounter++, step.label, (i + 0.45) / total);
    }, 95);

    try {
      const detail = (await step.action?.()) ?? "";
      await sleep(160);
      clearInterval(timer);
      completedLines.push(
        `  ${EMERALD}✓${RESET} ${BONE}${step.label}${detail ? ` ${MUTED}(${detail})${RESET}` : ""}${RESET}`,
      );
      paint(frameCounter++, step.label, (i + 1) / total);
    } catch (err) {
      clearInterval(timer);
      const msg = err instanceof Error ? err.message : "falha";
      completedLines.push(`  ${ORANGE}!${RESET} ${BONE}${step.label} ${MUTED}(${msg})${RESET}`);
      paint(frameCounter++, step.label, (i + 1) / total);
    }
  }

  stdout.write(`\n`);
}
