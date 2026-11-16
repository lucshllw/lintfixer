<div align="center">
  <img src="packages/lintfixer/assets/kat-brackets-badge.svg" alt="LintFixer Kat-Brackets Logo" width="96" height="96" />
  <h1>LintFixer</h1>
  <p><strong>Semantic Linter · Git Score · Verified Auto-Fix · GitHub Explorer · AES-256-GCM / DPAPI Vault</strong></p>
  <p>External desktop cockpit (<em>Rack Observatório</em>), animated NPM CLI (<em>Kat-Brackets</em>), commit guard, and fork-safe PR bot built with zero-I/O TypeScript core.</p>
</div>

---

## Highlights

- **Zero-LLM Pre-Filter & Git Score (`0–100`):** Classifies lockfiles, build artifacts, out-of-scope edits, and sensitive files before calling an LLM, saving tokens and displaying transparent scoring across 14 telemetry segments.
- **Grounded Semantic Linting & Verified Auto-Fix:** Multi-provider support (**Gemini**, **OpenAI**, **Claude**, plus local read-only CLIs) with nonce anti-prompt-injection boundaries, literal `evidenceHunk` grounding checks, protected target blocks (tests/lockfiles/workflows/configs), and automatic rollback on failure.
- **Native GitHub Explorer & Team Workflows:** Search public or authenticated repositories, inspect commits and open Pull Requests, and install zero-secret commit hooks (`pre-commit`, `commit-msg`) or PR Bot workflows.
- **Encrypted Local Vault (`AES-256-GCM + DPAPI`):** Starts completely logged out for every user; seals each user's API keys and GitHub OAuth / CLI sessions outside repositories using 96-bit IV, 128-bit AuthTag, strict `AAD`, and OS keystore master-key protection.
- **Animated Desktop Experience + CLI:** Loopback daemon (`127.0.0.1`) serving a 60fps GSAP + React 19 UI in an isolated `--app=` window, plus ANSI-animated NPM install/CLI launcher and Windows `.exe` installer.

## Packages

```text
packages/
├── core/           Pure zero-I/O domain engine (rules, redaction, slicing, Git Score, fixer, calibration, MemoryEventV1)
├── adapters/       Encrypted vault (AES-256-GCM + DPAPI), GitHub search/OAuth, LLM fetch/CLI routers, Git & FS adapters
├── cli/            Headless `ikigai` semantic review, calibration & PR commands
├── github-action/  Fork-safe GitHub Action PR Bot reading policy exclusively from protected `base_ref`
├── desktop-ui/     React 19 + TypeScript + Vite + GSAP + Lucide Rack Observatório UI
└── lintfixer/      Standalone NPM package (`lintfixer`), ANSI Kat-Brackets installer, loopback daemon & Windows `.exe` builder
```

## Quick Start

### 1. From Source (Monorepo)
```bash
pnpm install
pnpm check
pnpm build
```

### 2. Run Desktop UI / Setup Wizard
```bash
lintfixer            # animated Kat-Brackets boot + Rack Observatório external window
lintfixer setup      # guided onboarding for GitHub OAuth & Encrypted API Vault
lintfixer score HEAD --json
lintfixer github search "owner/repo"
lintfixer vault status
```

### 3. Windows Installer (`.exe`) & Standalone NPM Tarball
Building (`pnpm build`) outputs:
- `dist-installer/LintFixer-Setup.exe` — animated dark WinForms installer with Kat-Brackets icon
- `dist-installer/lintfixer-0.2.0.tgz` — standalone zero-dependency NPM bundle (`npm install -g`)

## Security Architecture

See [`SECURITY.md`](SECURITY.md). Every user runs completely unauthenticated on first boot until they connect their own GitHub account (via OAuth Device Flow, local `gh` CLI session import, or encrypted PAT) and AI provider keys inside their OS-protected vault.
