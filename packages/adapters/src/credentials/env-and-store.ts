import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProviderKind } from "@ikigai/core";
import { createEncryptedVault, type VaultNamespace } from "./encrypted-vault.ts";

export type CredentialKeyName = "openai" | "gemini" | "claude" | "github";

export interface CredentialLookupResult {
  readonly found: boolean;
  readonly source: "env" | "encrypted-vault" | "legacy-store" | "missing";
  readonly value: string | null;
}

const ENV_VAR_BY_KEY: Readonly<Record<CredentialKeyName, string>> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  github: "GITHUB_TOKEN",
};

const NAMESPACE_BY_KEY: Readonly<Record<CredentialKeyName, VaultNamespace>> = {
  openai: "llm.openai",
  gemini: "llm.gemini",
  claude: "llm.claude",
  github: "github.oauth",
};

export function resolveIkigaiConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && isAbsolutePath(xdg)) {
    return join(xdg, "ikigai");
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  return join(home, ".config", "ikigai");
}

export function resolveIkigaiDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolutePath(xdg)) {
    return join(xdg, "ikigai");
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  return join(home, ".local", "share", "ikigai");
}

/**
 * Resolves credentials safely:
 * 1) environment variable override,
 * 2) OS-sealed AES-256-GCM encrypted vault (outside repository),
 * 3) read-only legacy ~/.config/ikigai/credentials.json fallback.
 */
export function resolveCredential(
  key: CredentialKeyName,
  repoRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialLookupResult {
  const envVar = ENV_VAR_BY_KEY[key];
  const fromEnv = env[envVar]?.trim();
  if (fromEnv) {
    return { found: true, source: "env", value: fromEnv };
  }

  try {
    const vault = createEncryptedVault({
      env,
      ...(repoRoot ? { repoRoot } : {}),
    });

    if (key === "github") {
      const oauth = vault.unsealSecret("github.oauth");
      if (oauth) {
        return { found: true, source: "encrypted-vault", value: oauth };
      }
      const pat = vault.unsealSecret("github.pat");
      if (pat) {
        return { found: true, source: "encrypted-vault", value: pat };
      }
    } else {
      const sealed = vault.unsealSecret(NAMESPACE_BY_KEY[key]);
      if (sealed) {
        return { found: true, source: "encrypted-vault", value: sealed };
      }
    }
  } catch {
    // Fall through to missing or read-only legacy check cleanly.
  }

  const legacyPath = join(resolveIkigaiConfigDir(env), "credentials.json");
  if (!existsSync(legacyPath)) {
    return { found: false, source: "missing", value: null };
  }

  if (repoRoot && isInsideDirectory(legacyPath, repoRoot)) {
    return { found: false, source: "missing", value: null };
  }

  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
    const val = raw[key];
    if (typeof val === "string" && val.trim() !== "") {
      return { found: true, source: "legacy-store", value: val.trim() };
    }
  } catch {
    return { found: false, source: "missing", value: null };
  }

  return { found: false, source: "missing", value: null };
}

/**
 * Seals credential using AES-256-GCM + OS Keystore/DPAPI. Never writes plaintext JSON.
 */
export function saveCredential(
  key: CredentialKeyName,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const vault = createEncryptedVault({ env });
  vault.setSecret(NAMESPACE_BY_KEY[key], secret);
  return join(vault.vaultDir, "secrets.enc.json");
}

export interface LegacyMigrationResult {
  readonly migratedCount: number;
  readonly keys: readonly CredentialKeyName[];
  readonly vaultDir: string;
}

/**
 * Imports any plaintext keys from legacy ~/.config/ikigai/credentials.json into
 * the OS-sealed AES-256-GCM vault and scrubs plaintext values from disk.
 */
export function migrateLegacyCredentialsToVault(
  env: NodeJS.ProcessEnv = process.env,
): LegacyMigrationResult {
  const legacyPath = join(resolveIkigaiConfigDir(env), "credentials.json");
  const vault = createEncryptedVault({ env });

  if (!existsSync(legacyPath)) {
    return { migratedCount: 0, keys: [], vaultDir: vault.vaultDir };
  }

  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
    const migrated: CredentialKeyName[] = [];

    for (const key of ["openai", "gemini", "claude", "github"] as const) {
      const value = raw[key];
      if (typeof value === "string" && value.trim().length >= 4) {
        const ns = key === "github" ? "github.pat" : NAMESPACE_BY_KEY[key];
        vault.setSecret(ns, value.trim());
        migrated.push(key);
      }
    }

    if (migrated.length > 0) {
      writeFileSync(
        legacyPath,
        `${JSON.stringify(
          {
            migratedToEncryptedVault: true,
            migratedAt: new Date().toISOString(),
            migratedKeys: migrated,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }

    return {
      migratedCount: migrated.length,
      keys: migrated,
      vaultDir: vault.vaultDir,
    };
  } catch {
    return { migratedCount: 0, keys: [], vaultDir: vault.vaultDir };
  }
}

export function providerToCredentialKey(provider: ProviderKind): CredentialKeyName | null {
  switch (provider) {
    case "openai":
      return "openai";
    case "gemini":
      return "gemini";
    case "claude":
      return "claude";
    case "cli":
      return null;
  }
}

function isInsideDirectory(candidatePath: string, rootDir: string): boolean {
  try {
    const realCandidate = realpathSync(dirname(candidatePath)).toLowerCase();
    const realRoot = realpathSync(resolve(rootDir)).toLowerCase();
    return (
      realCandidate === realRoot ||
      realCandidate.startsWith(`${realRoot}\\`) ||
      realCandidate.startsWith(`${realRoot}/`)
    );
  } catch {
    return false;
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
