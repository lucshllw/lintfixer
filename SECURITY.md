# Security Policy · LintFixer

## Zero-Secret Repository Model
- **No shared API keys in Git:** API keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and OAuth tokens are never committed or distributed inside repository files, installers, or NPM tarballs.
- **Local Encrypted Vault:** Each user's credentials are stored outside any repository and outside synced folders (`%LOCALAPPDATA%/LintFixer/vault` on Windows, `~/.local/share/lintfixer/vault` on Linux/macOS), encrypted per record with **AES-256-GCM** (96-bit IV, 128-bit AuthTag, strict `AAD` binding `{ app, v, namespace, endpoint }`) and a 32-byte master key sealed via OS Keystore (**Windows DPAPI `CurrentUser`**).
- **Loopback Isolation:** The local daemon binds exclusively to `127.0.0.1`, requires a per-session random `X-LintFixer-Token` / `HttpOnly; SameSite=Strict` cookie, validates `Host`/`Origin` headers, and never returns plaintext secrets over HTTP.
- **Team Commit & PR Enforcement:** Contributors run local git hooks using their own encrypted local credentials, while repository PR checks run via GitHub Actions reading `Secrets` only on trusted base branches (`forkPolicy: comment-only`).

## Reporting a Vulnerability
Do not open public issues with exploit payloads or credentials. Report security findings privately through GitHub Security Advisories.
