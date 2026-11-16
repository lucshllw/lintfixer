import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { startLintFixerDaemon } from "../packages/lintfixer/src/server/daemon.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const qaDir = join(repoRoot, "qa");
mkdirSync(qaDir, { recursive: true });

async function runQa() {
  const daemon = await startLintFixerDaemon({
    cwd: repoRoot,
    port: 0,
  });

  const browser = await chromium.launch({ headless: true });
  const results = {
    url: `http://127.0.0.1:${daemon.port}`,
    tabsChecked: [],
    axeViolations: [],
    vitals: null,
    fpsCheck: null,
    responsive: [],
    reducedMotionOk: false,
    introCapturedOk: false,
    sandboxLoadedOk: false,
    vaultZeroSecretLeakOk: false,
    urlTokenScrubbed: false,
  };

  try {
    // 1. Verify Boot Intro Animation renders visibly during boot & reveals app cleanly
    const introCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const introPage = await introCtx.newPage();
    await introPage.goto(daemon.url, { waitUntil: "domcontentloaded" });
    await introPage.waitForTimeout(220);
    const introVisible = await introPage.locator(".boot-overlay").isVisible().catch(() => false);
    await introPage.screenshot({ path: join(qaDir, "lintfixer-intro-boot.png") });
    await introPage.waitForTimeout(1100);
    const h1Text = await introPage.locator("h1").innerText();
    results.introCapturedOk = introVisible && h1Text.includes("LintFixer");
    await introCtx.close();

    // 2. Main Desktop Inspection across GitHub sandbox, Diff x Fix, Calibration, Vault + Axe + FPS
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const baseAppUrl = `${daemon.url}&no-intro=1`;
    await page.goto(baseAppUrl, { waitUntil: "networkidle" });
    results.urlTokenScrubbed = !page.url().includes("token=");

    const vitals = await page.evaluate(() => {
      const paint = performance.getEntriesByType("paint");
      const fcp = paint.find((p) => p.name === "first-contentful-paint")?.startTime ?? null;
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        fcpMs: fcp !== null ? Math.round(fcp) : null,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      };
    });
    results.vitals = vitals;

    const fps = await page.evaluate(
      () =>
        new Promise((resolveFps) => {
          const deltas = [];
          let last = performance.now();
          let count = 0;
          function tick(now) {
            deltas.push(now - last);
            last = now;
            count += 1;
            if (count < 45) {
              requestAnimationFrame(tick);
            } else {
              const sorted = deltas.slice(2).sort((a, b) => a - b);
              const medDelta = sorted[Math.floor(sorted.length / 2)] ?? 16.6;
              resolveFps({ medianFps: Math.round(1000 / Math.max(1, medDelta)), frames: count });
            }
          }
          requestAnimationFrame(tick);
        }),
    );
    results.fpsCheck = fps;

    // Test GitHub Search UI flow neutrally without hardcoded user repositories
    const searchInput = page.getByPlaceholder(/Buscar no GitHub/i);
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("octocat/Hello-World");
      results.sandboxLoadedOk = true;
    }

    const tabs = [
      { label: "GitHub & Git Score", screenshot: "qa-tab-github.png" },
      { label: "Diff × Fix", screenshot: "qa-tab-difffix.png" },
      { label: "Calibração", screenshot: "qa-tab-calibration.png" },
      { label: "Cofre Criptografado", screenshot: "qa-tab-vault.png" },
    ];

    for (const t of tabs) {
      await page.getByRole("navigation").getByRole("button", { name: new RegExp(t.label, "i") }).click();
      await page.waitForTimeout(350);

      if (t.label === "Calibração") {
        const runCalBtn = page.getByRole("button", { name: /RODAR CALIBRA/i });
        if (await runCalBtn.isVisible()) {
          await runCalBtn.click();
          await page.waitForTimeout(450);
        }
      }

      if (t.label === "Cofre Criptografado") {
        const bodyText = await page.locator("body").innerText();
        results.vaultZeroSecretLeakOk = !bodyText.includes("AIzaSy");
      }

      const axe = await new AxeBuilder({ page }).analyze();
      const serious = axe.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      results.axeViolations.push({
        tab: t.label,
        seriousCount: serious.length,
        ids: serious.map((s) => `${s.id}:${s.description}`),
      });

      await page.screenshot({ path: join(qaDir, t.screenshot) });
      results.tabsChecked.push(t.label);
    }

    // Back to GitHub tab for responsive width sweep (375, 768, 1440, 1920)
    await page.getByRole("navigation").getByRole("button", { name: /GitHub & Git Score/i }).click();
    await page.waitForTimeout(250);

    for (const width of [375, 768, 1440, 1920]) {
      const height = width < 768 ? 812 : 900;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(220);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      await page.screenshot({ path: join(qaDir, `qa-responsive-${width}.png`), fullPage: true });
      results.responsive.push({ width, horizontalOverflow: overflow });
    }

    await context.close();
    const rmCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const rmPage = await rmCtx.newPage();
    await rmPage.goto(daemon.url, { waitUntil: "networkidle" });
    await rmPage.waitForTimeout(200);
    results.reducedMotionOk = (await rmPage.locator(".boot-overlay").count()) === 0;
    await rmCtx.close();

    writeFileSync(join(qaDir, "qa-metrics.json"), JSON.stringify(results, null, 2), "utf8");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    await daemon.close();
  }
}

await runQa();
