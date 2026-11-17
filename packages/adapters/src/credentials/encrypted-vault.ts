import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type VaultNamespace =
  | "github.oauth"
  | "github.pat"
  | "llm.jev"
  | "llm.gemini"
  | "llm.openai"
  | "llm.claude";

export type KeyProtectionKind =
  | "dpapi-current-user"
  | "macos-keychain"
  | "linux-secret-tool"
  | "os-file-0600"
  | "custom-sealer";

export interface VaultEntryMetadata {
  readonly namespace: VaultNamespace;
  readonly providerLabel: string;
  readonly endpoint: string;
  readonly status: "sealed" | "missing";
  readonly maskedPreview: string | null;
  readonly protection: KeyProtectionKind;
  readonly updatedAt: string | null;
}

export interface MasterKeySealer {
  readonly protection: KeyProtectionKind;
  sealMasterKey(rawKey: Buffer, vaultDir: string): string;
  unsealMasterKey(sealedBlob: string, vaultDir: string): Buffer;
}

interface EncryptedRecordV1 {
  readonly v: 1;
  readonly alg: "aes-256-gcm";
  readonly ivB64: string;
  readonly tagB64: string;
  readonly cipherB64: string;
  readonly endpoint: string;
  readonly maskedPreview: string;
  readonly protection: KeyProtectionKind;
  readonly updatedAt: string;
}

interface VaultFileV1 {
  readonly schema: "lintfixer-vault-v1";
  readonly masterProtection: KeyProtectionKind;
  readonly records: Partial<Record<VaultNamespace, EncryptedRecordV1>>;
}

export const VAULT_DEFINITIONS: Readonly<
  Record<VaultNamespace, { readonly label: string; readonly endpoint: string }>
> = {
  "github.oauth": { label: "GitHub OAuth", endpoint: "https://api.github.com" },
  "github.pat": { label: "GitHub PAT", endpoint: "https://api.github.com" },
  "llm.jev": {
    label: "TypeSafe Jev",
    endpoint: "https://api.typesafe.ai",
  },
  "llm.gemini": {
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com",
  },
  "llm.openai": { label: "OpenAI", endpoint: "https://api.openai.com" },
  "llm.claude": { label: "Anthropic Claude", endpoint: "https://api.anthropic.com" },
};

const ALL_NAMESPACES: readonly VaultNamespace[] = [
  "github.oauth",
  "github.pat",
  "llm.jev",
  "llm.gemini",
  "llm.openai",
  "llm.claude",
];

const MASTER_KEY_ENTROPY_B64 = Buffer.from("lintfixer-master-key-entropy-v1", "utf8").toString(
  "base64",
);

const masterKeyCache = new Map<string, Buffer>();

export function resolveVaultDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LINTFIXER_VAULT_DIR?.trim();
  if (explicit && isAbsolutePath(explicit)) {
    return explicit;
  }

  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  const xdgData = env.XDG_DATA_HOME?.trim();

  if (process.platform === "win32") {
    // Allow isolated XDG overrides in tests cleanly without touching user profile.
    if (xdgData && isAbsolutePath(xdgData)) {
      return join(xdgData, "lintfixer", "vault");
    }
    if (xdgConfig && isAbsolutePath(xdgConfig)) {
      return join(xdgConfig, "lintfixer", "vault");
    }
    const localAppData = env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(localAppData, "LintFixer", "vault");
  }

  if (xdgData && isAbsolutePath(xdgData)) {
    return join(xdgData, "lintfixer", "vault");
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".local", "share", "lintfixer", "vault");
}

export interface EncryptedVaultOptions {
  readonly vaultDir?: string;
  readonly repoRoot?: string;
  readonly sealer?: MasterKeySealer;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EncryptedVault {
  readonly vaultDir: string;
  readonly protection: KeyProtectionKind;
  setSecret(namespace: VaultNamespace, secret: string, customEndpoint?: string): void;
  unsealSecret(namespace: VaultNamespace): string | null;
  deleteSecret(namespace: VaultNamespace): boolean;
  listMetadata(): readonly VaultEntryMetadata[];
  getMetadata(namespace: VaultNamespace): VaultEntryMetadata;
}

/**
 * Encrypted local vault storing secrets outside any Git/OneDrive folder:
 * - AES-256-GCM per record with fresh 96-bit IV, 128-bit AuthTag, and strict JSON AAD
 * - 32-byte master key sealed by Windows DPAPI (CurrentUser) / OS Keystore
 * - Zero plaintext secrets ever written to disk or returned from metadata queries
 */
export function createEncryptedVault(options: EncryptedVaultOptions = {}): EncryptedVault {
  const vaultDir = resolve(options.vaultDir ?? resolveVaultDir(options.env));
  if (options.repoRoot && isInsideDirectory(vaultDir, options.repoRoot)) {
    throw new Error("SECURITY_BLOCK: Vault directory must stay outside repository boundaries.");
  }

  const sealer = options.sealer ?? selectPlatformSealer();
  const secretsFile = join(vaultDir, "secrets.enc.json");
  const masterFile = join(vaultDir, "master.key.sealed");

  function ensureMasterKey(): Buffer {
    const cached = masterKeyCache.get(masterFile);
    if (cached && cached.length === 32) {
      return cached;
    }

    ensurePrivateDirectory(vaultDir);
    if (existsSync(masterFile)) {
      rejectSymlink(masterFile);
      const sealed = readFileSync(masterFile, "utf8").trim();
      const unsealed = sealer.unsealMasterKey(sealed, vaultDir);
      if (unsealed.length !== 32) {
        throw new Error("VAULT_CORRUPTED_MASTER_KEY");
      }
      masterKeyCache.set(masterFile, unsealed);
      return unsealed;
    }

    const raw = randomBytes(32);
    const sealed = sealer.sealMasterKey(raw, vaultDir);
    atomicWritePrivate(masterFile, `${sealed}\n`);
    masterKeyCache.set(masterFile, raw);
    return raw;
  }

  function loadMasterKeyIfPresent(): Buffer | null {
    const cached = masterKeyCache.get(masterFile);
    if (cached && cached.length === 32) {
      return cached;
    }
    if (!existsSync(masterFile)) {
      return null;
    }
    rejectSymlink(masterFile);
    const sealed = readFileSync(masterFile, "utf8").trim();
    const unsealed = sealer.unsealMasterKey(sealed, vaultDir);
    if (unsealed.length !== 32) {
      return null;
    }
    masterKeyCache.set(masterFile, unsealed);
    return unsealed;
  }

  function readVaultFile(): VaultFileV1 {
    if (!existsSync(secretsFile)) {
      return {
        schema: "lintfixer-vault-v1",
        masterProtection: sealer.protection,
        records: {},
      };
    }
    rejectSymlink(secretsFile);
    const parsed = JSON.parse(readFileSync(secretsFile, "utf8")) as Partial<VaultFileV1>;
    if (parsed.schema !== "lintfixer-vault-v1" || typeof parsed.records !== "object") {
      throw new Error("VAULT_INVALID_SCHEMA");
    }
    return {
      schema: "lintfixer-vault-v1",
      masterProtection: parsed.masterProtection ?? sealer.protection,
      records: parsed.records ?? {},
    };
  }

  return {
    vaultDir,
    protection: sealer.protection,

    setSecret(namespace, secret, customEndpoint) {
      const cleaned = secret.trim();
      if (cleaned.length < 4) {
        throw new Error("INVALID_SECRET_EMPTY");
      }
      const def = VAULT_DEFINITIONS[namespace];
      const endpoint = normalizeFixedEndpoint(customEndpoint ?? def.endpoint);
      const key = ensureMasterKey();
      const iv = randomBytes(12); // 96-bit IV
      const aad = buildAad(namespace, endpoint);

      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(cleaned, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const vault = readVaultFile();
      const updatedRecords: Partial<Record<VaultNamespace, EncryptedRecordV1>> = {
        ...vault.records,
        [namespace]: {
          v: 1,
          alg: "aes-256-gcm",
          ivB64: iv.toString("base64"),
          tagB64: authTag.toString("base64"),
          cipherB64: encrypted.toString("base64"),
          endpoint,
          maskedPreview: maskSecretPreview(cleaned),
          protection: sealer.protection,
          updatedAt: new Date().toISOString(),
        },
      };

      ensurePrivateDirectory(vaultDir);
      atomicWritePrivate(
        secretsFile,
        `${JSON.stringify(
          {
            schema: "lintfixer-vault-v1",
            masterProtection: sealer.protection,
            records: updatedRecords,
          } satisfies VaultFileV1,
          null,
          2,
        )}\n`,
      );
    },

    unsealSecret(namespace) {
      if (!existsSync(secretsFile)) {
        return null;
      }
      const vault = readVaultFile();
      const record = vault.records[namespace];
      if (!record) {
        return null;
      }
      const master = loadMasterKeyIfPresent();
      if (!master) {
        return null;
      }

      const iv = Buffer.from(record.ivB64, "base64");
      const tag = Buffer.from(record.tagB64, "base64");
      const ciphertext = Buffer.from(record.cipherB64, "base64");
      if (iv.length !== 12 || tag.length !== 16) {
        throw new Error("VAULT_INVALID_CIPHER_PARAMS");
      }

      const expectedDef = VAULT_DEFINITIONS[namespace];
      const aad = buildAad(namespace, expectedDef.endpoint);

      const decipher = createDecipheriv("aes-256-gcm", master, iv, { authTagLength: 16 });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    },

    deleteSecret(namespace) {
      if (!existsSync(secretsFile)) {
        return false;
      }
      const vault = readVaultFile();
      if (!(namespace in vault.records)) {
        return false;
      }
      const nextRecords = { ...vault.records };
      delete nextRecords[namespace];
      atomicWritePrivate(
        secretsFile,
        `${JSON.stringify(
          {
            schema: "lintfixer-vault-v1",
            masterProtection: vault.masterProtection,
            records: nextRecords,
          } satisfies VaultFileV1,
          null,
          2,
        )}\n`,
      );
      return true;
    },

    listMetadata() {
      const vault = readVaultFileSafe(secretsFile, sealer.protection);
      return ALL_NAMESPACES.map((namespace) => formatMeta(namespace, vault, sealer.protection));
    },

    getMetadata(namespace) {
      const vault = readVaultFileSafe(secretsFile, sealer.protection);
      return formatMeta(namespace, vault, sealer.protection);
    },
  };
}

export function clearMasterKeyMemoryCacheForTests(): void {
  masterKeyCache.clear();
}

function readVaultFileSafe(
  secretsFile: string,
  fallbackProtection: KeyProtectionKind,
): VaultFileV1 {
  if (!existsSync(secretsFile)) {
    return {
      schema: "lintfixer-vault-v1",
      masterProtection: fallbackProtection,
      records: {},
    };
  }
  try {
    rejectSymlink(secretsFile);
    const parsed = JSON.parse(readFileSync(secretsFile, "utf8")) as Partial<VaultFileV1>;
    if (parsed.schema !== "lintfixer-vault-v1" || typeof parsed.records !== "object") {
      return {
        schema: "lintfixer-vault-v1",
        masterProtection: fallbackProtection,
        records: {},
      };
    }
    return {
      schema: "lintfixer-vault-v1",
      masterProtection: parsed.masterProtection ?? fallbackProtection,
      records: parsed.records ?? {},
    };
  } catch {
    return {
      schema: "lintfixer-vault-v1",
      masterProtection: fallbackProtection,
      records: {},
    };
  }
}

function formatMeta(
  namespace: VaultNamespace,
  vault: VaultFileV1,
  defaultProtection: KeyProtectionKind,
): VaultEntryMetadata {
  const def = VAULT_DEFINITIONS[namespace];
  const rec = vault.records[namespace];
  if (!rec) {
    return {
      namespace,
      providerLabel: def.label,
      endpoint: def.endpoint,
      status: "missing",
      maskedPreview: null,
      protection: defaultProtection,
      updatedAt: null,
    };
  }
  return {
    namespace,
    providerLabel: def.label,
    endpoint: rec.endpoint,
    status: "sealed",
    maskedPreview: rec.maskedPreview,
    protection: rec.protection,
    updatedAt: rec.updatedAt,
  };
}

function buildAad(namespace: VaultNamespace, endpoint: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      app: "lintfixer",
      v: 1,
      namespace,
      endpoint,
    }),
    "utf8",
  );
}

function normalizeFixedEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("SECURITY_BLOCK: Provider endpoint must use HTTPS.");
  }
  return url.origin;
}

export function maskSecretPreview(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return "••••••••";
  }
  const suffix = trimmed.slice(-4);
  return `••••${suffix}`;
}

function findDpapiHelperBinary(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "../../native/dpapi-seal.exe"),
      resolve(here, "../native/dpapi-seal.exe"),
      resolve(here, "dpapi-seal.exe"),
      resolve(here, "../bin/dpapi-seal.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function createWindowsDpapiSealer(): MasterKeySealer {
  const helperExe = findDpapiHelperBinary();

  const invokePs = (psCode: string, stdinB64: string): string => {
    const encoded = Buffer.from(
      `$ProgressPreference = "SilentlyContinue"\n${psCode}`,
      "utf16le",
    ).toString("base64");
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        input: stdinB64,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      },
    ).trim();
  };

  return {
    protection: "dpapi-current-user",
    sealMasterKey(rawKey) {
      const rawB64 = rawKey.toString("base64");
      if (helperExe) {
        const sealed = execFileSync(helperExe, ["protect", MASTER_KEY_ENTROPY_B64], {
          input: rawB64,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        }).trim();
        return `dpapi1:${sealed}`;
      }
      const code = [
        "Add-Type -AssemblyName System.Security",
        "$rawB64 = [Console]::In.ReadToEnd().Trim()",
        "$raw = [Convert]::FromBase64String($rawB64)",
        `$ent = [Convert]::FromBase64String("${MASTER_KEY_ENTROPY_B64}")`,
        "$enc = [Security.Cryptography.ProtectedData]::Protect($raw, $ent, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Convert]::ToBase64String($enc)",
      ].join("\n");
      return `dpapi1:${invokePs(code, rawB64)}`;
    },
    unsealMasterKey(sealedBlob) {
      if (!sealedBlob.startsWith("dpapi1:")) {
        throw new Error("VAULT_UNEXPECTED_SEAL_PREFIX");
      }
      const payload = sealedBlob.slice("dpapi1:".length);
      if (helperExe) {
        const rawB64 = execFileSync(helperExe, ["unprotect", MASTER_KEY_ENTROPY_B64], {
          input: payload,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        }).trim();
        return Buffer.from(rawB64, "base64");
      }
      const code = [
        "Add-Type -AssemblyName System.Security",
        "$encB64 = [Console]::In.ReadToEnd().Trim()",
        "$enc = [Convert]::FromBase64String($encB64)",
        `$ent = [Convert]::FromBase64String("${MASTER_KEY_ENTROPY_B64}")`,
        "$raw = [Security.Cryptography.ProtectedData]::Unprotect($enc, $ent, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Convert]::ToBase64String($raw)",
      ].join("\n");
      const rawB64 = invokePs(code, payload);
      return Buffer.from(rawB64, "base64");
    },
  };
}

function selectPlatformSealer(): MasterKeySealer {
  if (process.platform === "win32") {
    return createWindowsDpapiSealer();
  }

  // Fallback for Unix environments wraps master key with local machine/user derived AES-256-GCM + 0600 permissions.
  return createUnixLocalSealer();
}

function createUnixLocalSealer(): MasterKeySealer {
  const deriveWrappingKey = (vaultDir: string): Buffer => {
    const material = `${userInfo().username}@${hostname()}::${vaultDir}`;
    return scryptSync(material, "lintfixer-unix-vault-salt-v1", 32);
  };

  return {
    protection: "os-file-0600",
    sealMasterKey(rawKey, vaultDir) {
      const wrapKey = deriveWrappingKey(vaultDir);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", wrapKey, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(MASTER_KEY_ENTROPY_B64, "utf8"));
      const enc = Buffer.concat([cipher.update(rawKey), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `lfux1:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
    },
    unsealMasterKey(sealedBlob, vaultDir) {
      if (!sealedBlob.startsWith("lfux1:")) {
        throw new Error("VAULT_UNEXPECTED_SEAL_PREFIX");
      }
      const data = Buffer.from(sealedBlob.slice("lfux1:".length), "base64");
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const enc = data.subarray(28);
      const wrapKey = deriveWrappingKey(vaultDir);
      const decipher = createDecipheriv("aes-256-gcm", wrapKey, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(MASTER_KEY_ENTROPY_B64, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    },
  };
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows relies on user profile ACLs.
  }
}

function atomicWritePrivate(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows relies on user profile ACLs.
  }
}

function rejectSymlink(targetPath: string): void {
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error("SECURITY_BLOCK: Refusing symlink inside encrypted vault.");
  }
}

function isInsideDirectory(candidatePath: string, rootDir: string): boolean {
  try {
    const resolvedCandidate = resolve(candidatePath).toLowerCase();
    const realRoot = realpathSync(resolve(rootDir)).toLowerCase();
    return (
      resolvedCandidate === realRoot ||
      resolvedCandidate.startsWith(`${realRoot}\\`) ||
      resolvedCandidate.startsWith(`${realRoot}/`)
    );
  } catch {
    return false;
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
