import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startLintFixerDaemon } from "../packages/lintfixer/src/server/daemon.ts";

const repoRoot = resolve(import.meta.dirname, "..");

async function main() {
  const daemon = await startLintFixerDaemon({ cwd: repoRoot, port: 0 });
  const browser = await chromium.launch({ headless: true });

  const rounds = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const client = await ctx.newCDPSession(page);
      await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await client.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });

      await page.addInitScript(() => {
        window.__qaVitals = { lcp: 0, fcp: 0, cls: 0, tbt: 0 };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__qaVitals.lcp = Math.max(window.__qaVitals.lcp, e.startTime);
          }
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) window.__qaVitals.cls += e.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.duration > 50) window.__qaVitals.tbt += e.duration - 50;
          }
        }).observe({ type: "longtask", buffered: true });
      });

      await page.goto(`${daemon.url}&no-intro=1`, { waitUntil: "load" });
      await page.waitForTimeout(800);
      const perf = await page.evaluate(() => {
        const fcp =
          performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint")
            ?.startTime ?? 0;
        return {
          fcpMs: Math.round(fcp),
          lcpMs: Math.round(window.__qaVitals.lcp || fcp),
          cls: Number(window.__qaVitals.cls.toFixed(4)),
          tbtMs: Math.round(window.__qaVitals.tbt),
        };
      });
      rounds.push(perf);
      await ctx.close();
    }

    const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const summary = {
      method: "Playwright CDP PerformanceObserver (CPU 4x + 4G, median of 3 runs)",
      rounds,
      median: {
        fcpMs: median(rounds.map((r) => r.fcpMs)),
        lcpMs: median(rounds.map((r) => r.lcpMs)),
        cls: median(rounds.map((r) => r.cls)),
        tbtMs: median(rounds.map((r) => r.tbtMs)),
      },
    };
    writeFileSync(join(repoRoot, "qa", "qa-vitals-cdp.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
    await daemon.close();
  }
}

await main();
