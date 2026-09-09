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

const MAX_TEXT_LENGTH = 50000;
const BROWSER_OPTIONS = { stickyAttempt: true };

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node js/fetch_page.js <url>");
    process.exit(1);
  }

  let target;
  try {
    target = new URL(url);
  } catch (err) {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    console.error(`Unsupported URL scheme: ${target.protocol}`);
    process.exit(1);
  }

  const browser = await puppeteer.launch(launchOptions(BROWSER_OPTIONS));
  try {
    const page = await browser.newPage();
    const auth = proxyAuth(BROWSER_OPTIONS);
    if (auth) {
      await page.authenticate(auth);
    }
    await configureRegionalPage(page);
    await configureViewport(page);
    await debugBrowser(browser, page);

    await page.setRequestInterception(true);
    let resourceTypeWarningShown = false;
    page.on("request", (request) => {
      // Firefox's WebDriver BiDi implementation does not expose resourceType.
      // If it is unavailable, continue the request instead of breaking fetches.
      let type = null;
      try {
        type = request.resourceType();
      } catch (error) {
        if (!resourceTypeWarningShown) {
          resourceTypeWarningShown = true;
          debug(
            `Request resource type unavailable; resource filtering disabled: ${String(
              error
            )}`
          );
        }
      }
      if (type === "image" || type === "font" || type === "media") {
        request.abort();
      } else {
        request.continue();
      }
    });

    debug(`Page navigation URL: ${JSON.stringify(target.href)}`);
    const response = await page.goto(target.href, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    debugResponse(response, "Fetched page");
    if (response && response.status() >= 400) {
      await debugPagePreview(page, "Fetched page HTTP error");
    }
    await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    const text = await page.evaluate(() =>
      document.body ? document.body.innerText : ""
    );

    const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
    debug(`Extracted page text: characters=${cleaned.length}`);
    if (cleaned.length > MAX_TEXT_LENGTH) {
      console.log(cleaned.slice(0, MAX_TEXT_LENGTH) + "\n\n[Text truncated]");
    } else {
      console.log(cleaned);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  debug(
    `Unhandled fetch_page.js error: ${
      err && err.stack ? err.stack : String(err)
    }`
  );
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
