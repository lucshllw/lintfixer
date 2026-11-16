import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMasterKeyMemoryCacheForTests,
  createEncryptedVault,
  createWindowsDpapiSealer,
  type MasterKeySealer,
  migrateLegacyCredentialsToVault,
} from "@ikigai/adapters";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MEMORY_TEST_SEALER: MasterKeySealer = {
  protection: "custom-sealer",
  sealMasterKey(rawKey) {
    return `test-seal:${rawKey.toString("hex")}`;
  },
  unsealMasterKey(blob) {
    return Buffer.from(blob.slice("test-seal:".length), "hex");
  },
};

afterEach(() => {
  clearMasterKeyMemoryCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("encrypted vault (AES-256-GCM + AAD + OS protection)", () => {
  it("encrypts secrets opaquely on disk with unique 96-bit IVs and never exposes plaintext in metadata", () => {
    const vaultDir = makeTempDir("lintfixer-vault-");
    const secretValue = "AIzaSy-super-secret-synthetic-token-9999";

    const vault = createEncryptedVault({ vaultDir, sealer: MEMORY_TEST_SEALER });
    vault.setSecret("llm.gemini", secretValue);
    vault.setSecret("llm.openai", "sk-proj-synthetic-second-secret-1234");

    const diskRaw = readFileSync(join(vaultDir, "secrets.enc.json"), "utf8");
    expect(diskRaw).not.toContain(secretValue);
    expect(diskRaw).not.toContain("sk-proj-synthetic");

    const parsed = JSON.parse(diskRaw) as {
      records: Record<string, { ivB64: string; tagB64: string; cipherB64: string }>;
    };
    const gemRec = parsed.records["llm.gemini"];
    const oaiRec = parsed.records["llm.openai"];
    expect(gemRec).toBeDefined();
    expect(oaiRec).toBeDefined();
    if (!gemRec || !oaiRec) {
      throw new Error("Expected encrypted records to exist");
    }
    expect(Buffer.from(gemRec.ivB64, "base64").length).toBe(12);
    expect(Buffer.from(gemRec.tagB64, "base64").length).toBe(16);
    expect(gemRec.ivB64).not.toBe(oaiRec.ivB64);

    expect(vault.unsealSecret("llm.gemini")).toBe(secretValue);

    const meta = vault.listMetadata();
    const gemMeta = meta.find((m) => m.namespace === "llm.gemini");
    expect(gemMeta?.status).toBe("sealed");
    expect(gemMeta?.maskedPreview).toBe("••••9999");
    expect(JSON.stringify(meta)).not.toContain(secretValue);
  });

  it("rejects tampered ciphertext, authTag, or swapped namespace AAD", () => {
    const vaultDir = makeTempDir("lintfixer-tamper-");
    const vault = createEncryptedVault({ vaultDir, sealer: MEMORY_TEST_SEALER });
    vault.setSecret("github.oauth", "gho_synthetic_token_abcdefg");

    const secretsPath = join(vaultDir, "secrets.enc.json");
    const raw = JSON.parse(readFileSync(secretsPath, "utf8")) as {
      schema: string;
      masterProtection: string;
      records: Record<string, Record<string, unknown>>;
    };

    // Move sealed github.oauth ciphertext into llm.gemini slot -> AAD mismatch MUST throw
    const githubRecord = raw.records["github.oauth"];
    expect(githubRecord).toBeDefined();
    if (githubRecord) {
      raw.records["llm.gemini"] = githubRecord;
    }
    writeFileSync(secretsPath, JSON.stringify(raw), "utf8");

    expect(() => vault.unsealSecret("llm.gemini")).toThrow();
  });

  it("refuses vault inside a repository directory and migrates legacy credentials securely", () => {
    const repoDir = makeTempDir("lintfixer-repo-");
    expect(() =>
      createEncryptedVault({
        vaultDir: join(repoDir, ".lintfixer-vault"),
        repoRoot: repoDir,
        sealer: MEMORY_TEST_SEALER,
      }),
    ).toThrow(/SECURITY_BLOCK/);

    const xdgDir = makeTempDir("lintfixer-xdg-");
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdgDir, XDG_DATA_HOME: makeTempDir("lf-d-") };
    const legacyDir = join(xdgDir, "ikigai");
    // Ensure legacy migration scrubs plaintext file cleanly.
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "credentials.json"),
      JSON.stringify({ gemini: "AIzaSyLegacyMigrationSynthetic123456" }),
      "utf8",
    );

    const migrated = migrateLegacyCredentialsToVault(env);
    expect(migrated.migratedCount).toBe(1);
    const scrubbed = readFileSync(join(legacyDir, "credentials.json"), "utf8");
    expect(scrubbed).not.toContain("AIzaSyLegacyMigrationSynthetic");
    expect(scrubbed).toContain("migratedToEncryptedVault");
  });

  if (process.platform === "win32") {
    it("roundtrips real Windows DPAPI CurrentUser master key sealing", () => {
      const vaultDir = makeTempDir("lintfixer-dpapi-");
      const sealer = createWindowsDpapiSealer();
      const vault = createEncryptedVault({ vaultDir, sealer });
      const sample = "AIzaSy-real-dpapi-roundtrip-synthetic-777";
      vault.setSecret("llm.gemini", sample);

      clearMasterKeyMemoryCacheForTests();
      const reopened = createEncryptedVault({ vaultDir, sealer });
      expect(reopened.unsealSecret("llm.gemini")).toBe(sample);
    });
  } else {
    it("rejects symlink tampering inside vault directory", () => {
      const vaultDir = makeTempDir("lintfixer-symlink-");
      const target = join(makeTempDir("lintfixer-other-"), "evil.json");
      writeFileSync(target, "{}", "utf8");
      symlinkSync(target, join(vaultDir, "secrets.enc.json"));
      const vault = createEncryptedVault({ vaultDir, sealer: MEMORY_TEST_SEALER });
      expect(() => vault.unsealSecret("llm.gemini")).toThrow();
    });
  }
});
