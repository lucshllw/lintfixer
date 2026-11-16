import { execFile } from "node:child_process";
import type { ProviderEndpointConfig, ProviderTelemetry } from "@ikigai/core";
import { parseLooseJsonObject } from "./schema.ts";

export interface CliExecOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export type CliCompletionResult =
  | { readonly ok: true; readonly payload: unknown; readonly telemetry: ProviderTelemetry }
  | { readonly ok: false; readonly errorCode: string; readonly telemetry: ProviderTelemetry };

/**
 * Invokes local coding-agent CLIs (`claude`, `codex`, or custom read-only CLI)
 * strictly via `execFile` without shell interpolation and with tools disabled.
 */
export async function callLocalCliJson(
  endpoint: ProviderEndpointConfig,
  systemPrompt: string,
  userPrompt: string,
  options: CliExecOptions,
): Promise<CliCompletionResult> {
  const startedAt = Date.now();
  const combinedPrompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond with raw JSON only.`;
  const commandSpec = buildCliCommand(endpoint, combinedPrompt);

  if (commandSpec === null) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_CLI_PROVIDER",
      telemetry: { provider: endpoint.provider, modelId: endpoint.model, latencyMs: 0 },
    };
  }

  return new Promise((resolve) => {
    const child = execFile(
      commandSpec.bin,
      commandSpec.args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        const latencyMs = Date.now() - startedAt;
        const telemetry: ProviderTelemetry = {
          provider: endpoint.provider,
          modelId: endpoint.model,
          latencyMs,
        };

        if (err) {
          resolve({ ok: false, errorCode: "CLI_EXEC_FAILED", telemetry });
          return;
        }

        try {
          const parsedOuter = parseLooseJsonObject(stdout);
          const payload = unwrapCliEnvelope(parsedOuter);
          resolve({ ok: true, payload, telemetry });
        } catch {
          resolve({ ok: false, errorCode: "CLI_INVALID_JSON", telemetry });
        }
      },
    );

    if (commandSpec.stdinText !== undefined && child.stdin) {
      child.stdin.write(commandSpec.stdinText);
      child.stdin.end();
    }
  });
}

function buildCliCommand(
  endpoint: ProviderEndpointConfig,
  prompt: string,
): { readonly bin: string; readonly args: string[]; readonly stdinText?: string } | null {
  if (endpoint.provider === "claude") {
    return {
      bin: endpoint.cliCommand ?? "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "--model",
        endpoint.model,
        "--tools",
        "",
        "--no-session-persistence",
      ],
      stdinText: prompt,
    };
  }

  if (endpoint.provider === "openai") {
    return {
      bin: endpoint.cliCommand ?? "codex",
      args: ["exec", "--sandbox", "read-only", "--model", endpoint.model, "-"],
      stdinText: prompt,
    };
  }

  if (endpoint.provider === "cli" && endpoint.cliCommand) {
    return {
      bin: endpoint.cliCommand,
      args: ["--model", endpoint.model],
      stdinText: prompt,
    };
  }

  return null;
}

function unwrapCliEnvelope(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.result === "string") {
      return parseLooseJsonObject(rec.result);
    }
    if (typeof rec.output_text === "string") {
      return parseLooseJsonObject(rec.output_text);
    }
  }
  return parsed;
}
