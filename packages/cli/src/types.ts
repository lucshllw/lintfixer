import type { ProviderKind } from "@ikigai/core";

export interface CliIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinText: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface DoctorCheckItem {
  readonly name: string;
  readonly status: "OK" | "WARN" | "FAIL";
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly repoRoot: string | null;
  readonly checks: readonly DoctorCheckItem[];
}

export interface CalibrationFixtureFile {
  readonly version: 1;
  readonly threshold?: number;
  readonly cases: readonly {
    readonly fixtureId: string;
    readonly ruleId: string;
    readonly authorLabel: "VIOLATION" | "NO_VIOLATION";
    readonly task: string;
    readonly diff: string;
    readonly ruleSummary?: string;
    readonly violationCriteria?: string;
    readonly allowedCriteria?: string | null;
    readonly scopedPath?: string;
    readonly precomputedProbability?: number;
    readonly precomputedConfidence?: number;
    readonly sliceProbabilities?: readonly number[];
    readonly rationale?: string;
  }[];
}

export interface ParsedProviderOverride {
  readonly provider?: ProviderKind;
  readonly model?: string;
  readonly mode?: "api" | "cli";
}
