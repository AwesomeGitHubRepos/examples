// This mode intentionally keeps Puppeteer attached only to provide proxy
// authentication and profile selection. It performs no search automation.
process.env.ANSWERBOT_HEADED = "1";

const puppeteer = require("puppeteer-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth");
const {
  acquireProfileLock,
  configureRegionalPage,
  debug,
  googleProfilePath,
  googleRegionalSettings,
  launchOptions,
  proxyAuth,
  selectedBrowser,
  useStealth,
} = require("./browser");

useStealth(puppeteer, stealthPlugin);

const SEARCH_BROWSER_OPTIONS = {
  stickyAttempt: true,
  persistentProfile: true,
};
const REGIONAL_SETTINGS = googleRegionalSettings();
const GOOGLE_HOME_URL =
  `https://www.google.com/?hl=${encodeURIComponent(REGIONAL_SETTINGS.language)}` +
  `&gl=${encodeURIComponent(REGIONAL_SETTINGS.country)}`;

function manualLaunchOptions() {
  const options = launchOptions(SEARCH_BROWSER_OPTIONS);
  return {
    ...options,
    defaultViewport: null,
    args: [...(options.args || [])],
  };
}

async function configurePage(page, auth, regionalSettings = null) {
  if (auth) {
    await page.authenticate(auth);
  }
  if (regionalSettings) {
    await configureRegionalPage(page, regionalSettings);
  }
}

async function authenticateTopLevelTarget(
  browser,
  target,
  auth,
  regionalSettings = null
) {
  const page = await target.page();
  if (!page) {
    return false;
  }

  // Firefox BiDi emits targetcreated for child frames and currently reports
  // those targets as type "page" too. Calling page.authenticate() on the
  // frame-rooted wrapper makes Firefox reject network.addIntercept because
  // the browsing context is not top-level. Real tabs/windows are present in
  // browser.pages(); child-frame wrappers are not.
  const topLevelPages = await browser.pages();
  if (!topLevelPages.includes(page)) {
    return false;
  }

  await configurePage(page, auth, regionalSettings);
  return true;
}

async function main() {
  const profileDir = googleProfilePath(SEARCH_BROWSER_OPTIONS);
  const releaseProfileLock = acquireProfileLock(profileDir);
  const releaseProfileLockOnExit = () => releaseProfileLock();
  process.once("exit", releaseProfileLockOnExit);

  let browser;
  try {
    browser = await puppeteer.launch(manualLaunchOptions());
    const auth = proxyAuth(SEARCH_BROWSER_OPTIONS);

    // Apply proxy credentials to the initial page and to tabs/windows opened by
    // the user. The credentials stay in Node and are not placed on Chrome's
    // command line or printed to the terminal.
    browser.on("targetcreated", (target) => {
      authenticateTopLevelTarget(browser, target, auth, REGIONAL_SETTINGS)
        .catch((error) =>
          debug(`Could not authenticate a newly opened page: ${String(error)}`)
        );
    });

    const existingPages = await browser.pages();
    const page = existingPages[0] || (await browser.newPage());
    await configurePage(page, auth, REGIONAL_SETTINGS);
    await page.goto(GOOGLE_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const browserName = selectedBrowser();
    console.error(
      `Manual Google browser is ready (${browserName === "firefox" ? "Firefox" : "Chrome"}).`
    );
    console.error(`Profile directory: ${profileDir}`);
    console.error(
      auth
        ? "DataImpulse sticky proxy is enabled for this browser session."
        : "DataImpulse proxy is disabled; this is the direct Google profile."
    );
    console.error(
      `Use ${browserName === "firefox" ? "Firefox" : "Chrome"} normally, then ` +
        "close the browser window to save the profile and return."
    );

    await new Promise((resolve) => browser.once("disconnected", resolve));
    browser = null;
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

if (require.main === module) {
  main().catch((error) => {
    debug(
      `Unhandled manual_browser.js error: ${
        error && error.stack ? error.stack : String(error)
      }`
    );
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  });
}

module.exports = {
  GOOGLE_HOME_URL,
  SEARCH_BROWSER_OPTIONS,
  authenticateTopLevelTarget,
  manualLaunchOptions,
};
