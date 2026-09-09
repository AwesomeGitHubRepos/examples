const puppeteer = require("puppeteer-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth");
const {
  configureRegionalPage,
  configureViewport,
  debug,
  debugBrowser,
  debugPagePreview,
  debugResponse,
  launchOptions,
  proxyAuth,
  useStealth,
} = require("./browser");

useStealth(puppeteer, stealthPlugin);

const SEARCH_PROXY_OPTIONS = { stickyAttempt: true };

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node js/search_ddg.js "<query>"');
    process.exit(1);
  }

  const browser = await puppeteer.launch(launchOptions(SEARCH_PROXY_OPTIONS));
  try {
    const page = await browser.newPage();
    const auth = proxyAuth(SEARCH_PROXY_OPTIONS);
    if (auth) {
      await page.authenticate(auth);
    }
    await configureRegionalPage(page);
    await configureViewport(page);
    await debugBrowser(browser, page);

    const url =
      "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    debug(`DuckDuckGo navigation URL: ${JSON.stringify(url)}`);
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    debugResponse(response, "DuckDuckGo");
    if (response && response.status() !== 200) {
      await debugPagePreview(page, "DuckDuckGo non-200 response");
      throw new Error(`DuckDuckGo responded ${response.status()}`);
    }
    await page.waitForSelector(".result__a", { timeout: 10000 }).catch(() => {});

    const results = await page.evaluate(() => {
      const out = [];
      const seen = new Set();

      document.querySelectorAll("a.result__a").forEach((anchor) => {
        try {
          const link = new URL(anchor.href, "https://duckduckgo.com");
          let target = link.href;
          if (/^\/l\/?$/i.test(link.pathname) && link.searchParams.has("uddg")) {
            target = link.searchParams.get("uddg");
          }
          const resolved = new URL(target);
          if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
          if (/(^|\.)duckduckgo\.com$/.test(resolved.hostname)) return;
          if (seen.has(resolved.href)) return;

          seen.add(resolved.href);
          out.push({ title: anchor.textContent.trim(), url: resolved.href });
        } catch (err) {
          return;
        }
      });

      return out;
    });
    debug(`DuckDuckGo parsed result count: ${results.length}`);
    if (results.length === 0) {
      await debugPagePreview(page, "DuckDuckGo empty results");
    }

    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  debug(
    `Unhandled search_ddg.js error: ${
      err && err.stack ? err.stack : String(err)
    }`
  );
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
