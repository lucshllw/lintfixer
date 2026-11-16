import { execFile } from "node:child_process";

/**
 * Lightweight OpenCode V2 plugin shim delegating semantic review to the Ikigai CLI.
 */
export default function ikigaiOpenCodePlugin() {
  return {
    id: "ikigai",
    async setup() {
      return {
        "session.idle": async ({ directory }: { directory?: string }) => {
          await new Promise<void>((resolve) => {
            execFile(
              "npx",
              ["ikigai", "check", "--staged", "--json"],
              { cwd: directory ?? process.cwd(), timeout: 60_000, windowsHide: true },
              () => resolve(),
            );
          });
        },
      };
    },
  };
}
