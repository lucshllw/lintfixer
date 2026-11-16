import { resolveVaultDir } from "@ikigai/adapters";
import { canAnimateTerminal, runAnimatedKatIntro } from "./kat-ansi.ts";

async function main(): Promise<void> {
  // Respect non-interactive / CI installs silently without failing npm install.
  const vaultDir = resolveVaultDir();
  if (!canAnimateTerminal()) {
    console.log("LintFixer instalado. Execute `lintfixer` ou `npx lintfixer` para abrir a UI.");
    return;
  }

  await runAnimatedKatIntro({
    title: "Instalador NPM v0.2.0",
    steps: [
      { label: "Identidade Kat-Brackets registrada", action: () => "P&B CLI + Desktop" },
      { label: "Cofre AES-256-GCM + DPAPI pronto", action: () => vaultDir },
      { label: "Use `lintfixer` ou `lintfixer setup` para iniciar" },
    ],
  });
}

void main().catch(() => {
  // Never fail npm install postinstall hooks.
});
