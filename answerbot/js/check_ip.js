const puppeteer = require("puppeteer-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth");
const {
  configureRegionalPage,
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
  const browser = await puppeteer.launch(launchOptions(SEARCH_PROXY_OPTIONS));
  try {
    const page = await browser.newPage();
    const auth = proxyAuth(SEARCH_PROXY_OPTIONS);
    if (auth) {
      await page.authenticate(auth);
    }
    await configureRegionalPage(page);
    await debugBrowser(browser, page);
    const response = await page.goto("https://api.ipify.org", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    debugResponse(response, "ipify");
    if (response && response.status() !== 200) {
      await debugPagePreview(page, "ipify non-200 response");
      throw new Error(`ipify responded ${response.status()}`);
    }
    const ip = await page.evaluate(() => document.body.innerText.trim());
    debug(`Detected browser egress IP: ${ip}`);
    console.log(ip);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  debug(
    `Unhandled check_ip.js error: ${err && err.stack ? err.stack : String(err)}`
  );
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
