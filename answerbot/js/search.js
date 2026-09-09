const puppeteer = require("puppeteer-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth");
const {
  debug,
  debugBrowser,
  debugPagePreview,
  debugResponse,
  acquireProfileLock,
  configureRegionalPage,
  configureViewport,
  googleProfilePath,
  googleRegionalSettings,
  launchOptions,
  proxyAuth,
  useStealth,
} = require("./browser");
const { navigateGoogleSearch } = require("./google_search_navigation");
const { resolveGoogleConsent } = require("./google_consent");
const { handleGoogleChallenge } = require("./google_challenge");
const { extractGoogleResults } = require("./google_results");

useStealth(puppeteer, stealthPlugin);

const SEARCH_BROWSER_OPTIONS = {
  stickyAttempt: true,
  persistentProfile: true,
};
const REGIONAL_SETTINGS = googleRegionalSettings();
const GOOGLE_HOME_URL =
  `https://www.google.com/?hl=${encodeURIComponent(REGIONAL_SETTINGS.language)}` +
  `&gl=${encodeURIComponent(REGIONAL_SETTINGS.country)}`;
const WARMUP_DELAY_MS = 1500;
const INTERACTIVE = process.env.ANSWERBOT_INTERACTIVE === "1";
const HEADED = process.env.ANSWERBOT_HEADED === "1";
const RETRY = process.env.ANSWERBOT_RETRY === "1";

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node js/search.js "<query>"');
    process.exit(1);
  }

  const profileDir = googleProfilePath(SEARCH_BROWSER_OPTIONS);
  const releaseProfileLock = acquireProfileLock(profileDir);
  const releaseProfileLockOnExit = () => releaseProfileLock();
  process.once("exit", releaseProfileLockOnExit);
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions(SEARCH_BROWSER_OPTIONS));
    const existingPages = await browser.pages();
    const page = existingPages[0] || (await browser.newPage());
    debug(
      `Google browser context ready: existing_pages=${existingPages.length}; ` +
        `reused_initial_page=${existingPages.length > 0}`
    );
    const auth = proxyAuth(SEARCH_BROWSER_OPTIONS);
    if (auth) {
      await page.authenticate(auth);
    }
    await configureRegionalPage(page, REGIONAL_SETTINGS);
    await configureViewport(page);
    await debugBrowser(browser, page);

    debug(`Warming up Google at ${JSON.stringify(GOOGLE_HOME_URL)}`);
    const warmupResponse = await page.goto(GOOGLE_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    debugResponse(warmupResponse, "Google warm-up");
    if (
      warmupResponse &&
      (warmupResponse.status() === 429 || warmupResponse.status() === 403)
    ) {
      await debugPagePreview(page, "Google warm-up blocked response");
      throw new Error(
        `Google homepage responded ${warmupResponse.status()} during warm-up`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WARMUP_DELAY_MS));
    await resolveGoogleConsent(page);
    // A CAPTCHA can be served with HTTP 200. In retry mode (and in headless
    // mode) classify it before trying to interact with a missing search box.
    // Headed non-retry mode retains its existing manual challenge workflow.
    if (RETRY || !HEADED) {
      await handleGoogleChallenge(page, warmupResponse, {
        headed: HEADED,
        retry: RETRY,
      });
    }
    const warmupCookies = await page.cookies();
    debug(
      `Google warm-up complete: final_url=${JSON.stringify(page.url())}; ` +
        `cookies=${warmupCookies.length}; ` +
        `cookie_names=${JSON.stringify(warmupCookies.map((cookie) => cookie.name))}`
    );
    await debugBrowser(browser, page, "Google warm-up fingerprint");

    debug(
      `Google query submission mode: ${INTERACTIVE ? "interactive" : "direct URL"}`
    );
    const response = await navigateGoogleSearch(page, query, {
      interactive: INTERACTIVE,
      regionalSettings: REGIONAL_SETTINGS,
    });
    debugResponse(response, "Google");
    await debugBrowser(browser, page, "Google response fingerprint");
    const challengeHandled = await handleGoogleChallenge(page, response, {
      headed: HEADED,
      retry: RETRY,
    });
    if (challengeHandled) {
      await debugBrowser(browser, page, "Google post-challenge fingerprint");
    }
    await page
      .waitForSelector("#search h3, #rso h3", { timeout: 10000 })
      .catch(() => {});

    let results = await extractGoogleResults(page, {
      auth,
      regionalSettings: REGIONAL_SETTINGS,
    });
    debug(`Google parsed result count: ${results.length}`);

    if (results.length === 0) {
      const lateChallengeHandled = await handleGoogleChallenge(page, null, {
        headed: HEADED,
        retry: RETRY,
      });
      if (lateChallengeHandled) {
        await page
          .waitForSelector("#search h3, #rso h3", { timeout: 10000 })
          .catch(() => {});
        results = await extractGoogleResults(page, {
          auth,
          regionalSettings: REGIONAL_SETTINGS,
        });
        debug(`Google post-challenge parsed result count: ${results.length}`);
      } else {
        await debugPagePreview(page, "Google empty results");
      }
    }

    console.log(JSON.stringify(results));
  } finally {
    try {
      if (browser && browser.connected) {
        await browser.close();
      }
    } finally {
      process.removeListener("exit", releaseProfileLockOnExit);
      releaseProfileLock();
    }
  }
}

main().catch((err) => {
  debug(`Unhandled search.js error: ${err && err.stack ? err.stack : String(err)}`);
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
