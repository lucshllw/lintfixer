import type { RedactionResult } from "./types.ts";

interface SecretRule {
  readonly type: string;
  readonly pattern: RegExp;
}

const SECRET_RULES: readonly SecretRule[] = [
  {
    type: "PRIVATE_KEY",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { type: "OPENAI_KEY", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: "ANTHROPIC_KEY", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "GITHUB_TOKEN", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { type: "GITHUB_PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { type: "GOOGLE_API_KEY", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "AWS_KEY", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "SLACK_TOKEN", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    type: "AUTH_URI",
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g,
  },
  {
    type: "BEARER_TOKEN",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi,
  },
];

const SENSITIVE_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api_key|apikey|private_key|auth_key)[A-Za-z0-9_]*)\s*([:=])\s*(["']?)([^\s"'`;,]{12,})\3/gi;

const CRITICAL_RAW_SECRET_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16})\b/;

/**
 * Deterministically redacts secrets in text before any LLM prompt or disk log.
 * Uses pure FNV-1a 32-bit hash (zero Node crypto import required in core).
 */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let redactionCount = 0;

  for (const rule of SECRET_RULES) {
    if (rule.type === "AUTH_URI") {
      text = text.replace(rule.pattern, (_match, scheme: string, user: string, pass: string) => {
        redactionCount += 1;
        return `${scheme}[REDACTED:URI_CRED:${shortHash(`${user}:${pass}`)}]@`;
      });
      continue;
    }

    if (rule.type === "BEARER_TOKEN") {
      text = text.replace(rule.pattern, (match, prefix: string) => {
        if (match.includes("[REDACTED:")) {
          return match;
        }
        redactionCount += 1;
        return `${prefix}[REDACTED:BEARER:${shortHash(match.slice(prefix.length))}]`;
      });
      continue;
    }

    text = text.replace(rule.pattern, (match) => {
      redactionCount += 1;
      return `[REDACTED:${rule.type}:${shortHash(match)}]`;
    });
  }

  text = text.replace(
    SENSITIVE_ASSIGNMENT_RE,
    (full, key: string, sep: string, quote: string, val: string) => {
      if (val.includes("[REDACTED:") || isLikelyPlaceholder(val)) {
        return full;
      }
      if (shannonEntropy(val) < 3.0 && val.length < 24) {
        return full;
      }
      redactionCount += 1;
      return `${key}${sep}${quote}[REDACTED:SECRET:${shortHash(val)}]${quote}`;
    },
  );

  return {
    text,
    redactionCount,
    hasCriticalUnredacted: CRITICAL_RAW_SECRET_RE.test(text),
  };
}

function isLikelyPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("example") ||
    lower.includes("placeholder") ||
    lower.includes("dummy") ||
    lower.includes("changeme") ||
    lower.includes("your_") ||
    /^\$\{.*\}$/.test(value)
  );
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
