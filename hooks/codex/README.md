# Codex / Git Integration

Install local git hooks (`pre-commit` + `commit-msg`) in any repository:

```powershell
node packages/cli/src/main.ts hooks install
```

Or invoke directly from any Codex session:

```powershell
node packages/cli/src/main.ts check --staged --json
node packages/cli/src/main.ts check --diff change.diff --fix --apply --verify-cmd "pnpm test" --json
```
