const { debug, debugPagePreview } = require("./browser");

const MANUAL_POLL_INTERVAL_MS = 500;

async function inspectGoogleChallenge(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : "";
    const sorryPage = location.pathname.startsWith("/sorry/");
    const captchaElement = Boolean(
      document.querySelector(
        '#captcha-form, iframe[src*="recaptcha"], [class*="g-recaptcha"], [data-sitekey]'
      )
    );
    const unusualTraffic = /unusual traffic|not a robot/i.test(bodyText);
    return {
      detected: sorryPage || captchaElement || unusualTraffic,
      url: location.href,
      title: document.title,
      sorryPage,
      captchaElement,
      unusualTraffic,
    };
  });
}

async function waitForManualGoogleChallenge(page) {
  const browser = page.browser();
  console.error(
    "Google blocked the request. Complete the challenge in the open browser window; " +
      "the search will resume automatically, or close the browser to abort."
  );
  await page.bringToFront();

  const clearedPromise = page
    .waitForFunction(
      () => {
        const bodyText = document.body ? document.body.innerText : "";
        const blocked =
          location.pathname.startsWith("/sorry/") ||
          Boolean(
            document.querySelector(
              '#captcha-form, iframe[src*="recaptcha"], [class*="g-recaptcha"], [data-sitekey]'
            )
          ) ||
          /unusual traffic|not a robot/i.test(bodyText);
        const returnedToResults =
          location.pathname === "/search" ||
          Boolean(document.querySelector("#search"));
        return !blocked && returnedToResults;
      },
      { polling: MANUAL_POLL_INTERVAL_MS, timeout: 0 }
    )
    .then(async (handle) => {
      await handle.dispose();
      return "cleared";
    })
    .catch((error) => {
      if (!browser.connected) {
        return "closed";
      }
      throw error;
    });

  let disconnectedListener;
  const disconnectedPromise = new Promise((resolve) => {
    disconnectedListener = () => resolve("closed");
    if (browser.connected) {
      browser.once("disconnected", disconnectedListener);
    } else {
      resolve("closed");
    }
  });

  let outcome;
  try {
    outcome = await Promise.race([clearedPromise, disconnectedPromise]);
  } finally {
    if (disconnectedListener) {
      browser.off("disconnected", disconnectedListener);
    }
  }
  if (outcome === "closed") {
    throw new Error("Google challenge was not completed before the browser was closed");
  }

  debug(`Google manual challenge cleared: final_url=${JSON.stringify(page.url())}`);
}

async function handleGoogleChallenge(
  page,
  response,
  { headed = false, retry = false } = {}
) {
  const status = response ? response.status() : null;
  const state = await inspectGoogleChallenge(page);
  const blockedStatus = status === 429 || status === 403;
  if (!blockedStatus && !state.detected) {
    return false;
  }

  await debugPagePreview(page, "Google blocked response");
  if (!headed || retry) {
    if (blockedStatus) {
      throw new Error(`Google responded ${status} (rate-limited or blocked)`);
    }
    throw new Error("Google served a CAPTCHA block page");
  }

  debug(
    `Google challenge requires manual intervention: status=${status}; ` +
      `state=${JSON.stringify(state)}`
  );
  await waitForManualGoogleChallenge(page);

  const finalState = await inspectGoogleChallenge(page);
  if (finalState.detected) {
    throw new Error("Google challenge remained after manual intervention");
  }
  return true;
}

module.exports = {
  handleGoogleChallenge,
  inspectGoogleChallenge,
  waitForManualGoogleChallenge,
};
