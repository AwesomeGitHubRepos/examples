const {
  debug,
  debugPagePreview,
  googleRegionalSettings,
} = require("./browser");

const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const SEARCH_BOX_SELECTOR =
  'textarea[name="q"], input[name="q"], textarea[role="combobox"], input[role="combobox"]';
const SEARCH_BUTTON_SELECTOR =
  'input[name="btnK"], button[aria-label="Google Search"]';
const NAVIGATION_TIMEOUT_MS = 30000;
const SUBMIT_BUTTON_TIMEOUT_MS = 2000;
const TYPING_DELAY_MS = 75;

async function waitForVisibleElement(
  page,
  selector,
  { timeout = 10000, requireHitTarget = false } = {}
) {
  const handle = await page.waitForFunction(
    (candidateSelector, mustBeHitTarget) => {
      const candidates = Array.from(document.querySelectorAll(candidateSelector));
      return (
        candidates.find((element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const centerX = bounds.left + bounds.width / 2;
          const centerY = bounds.top + bounds.height / 2;
          const elementAtCenter = document.elementFromPoint(centerX, centerY);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) !== 0 &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            centerX >= 0 &&
            centerY >= 0 &&
            centerX <= innerWidth &&
            centerY <= innerHeight &&
            (!mustBeHitTarget ||
              elementAtCenter === element ||
              element.contains(elementAtCenter)) &&
            !element.disabled &&
            element.getAttribute("aria-hidden") !== "true"
          );
        }) || null
      );
    },
    { timeout },
    selector,
    requireHitTarget
  );
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error(`Visible element did not resolve to an ElementHandle: ${selector}`);
  }
  return element;
}

async function inspectSearchControls(page, expectedQuery) {
  return page.evaluate(
    (selector, requestedQuery) => {
      const describe = (element) => {
        if (!element) {
          return null;
        }

        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return {
          tagName: element.tagName,
          id: element.id || null,
          name: element.getAttribute("name"),
          role: element.getAttribute("role"),
          type: element.getAttribute("type"),
          value: "value" in element ? String(element.value) : null,
          active: document.activeElement === element,
          connected: element.isConnected,
          disabled: Boolean(element.disabled),
          readOnly: Boolean(element.readOnly),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          bounds: {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          },
        };
      };

      const candidates = Array.from(document.querySelectorAll(selector)).map(
        describe
      );
      return {
        activeElement: describe(document.activeElement),
        candidates,
        queryMatch: candidates.some(
          (candidate) => candidate.value === requestedQuery
        ),
      };
    },
    SEARCH_BOX_SELECTOR,
    expectedQuery
  );
}

async function submitGoogleSearchWithEnter(page) {
  debug("Google interactive search: submitting from the search box with Enter");
  let searchBox;
  try {
    searchBox = await waitForVisibleElement(page, SEARCH_BOX_SELECTOR);
    await searchBox.focus();
    const navigationPromise = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    const [response] = await Promise.all([
      navigationPromise,
      searchBox.press("Enter"),
    ]);
    return response;
  } catch (error) {
    await debugPagePreview(page, "Google interactive Enter submission failed");
    throw new Error(`Could not submit the Google query with Enter: ${error.message}`);
  } finally {
    if (searchBox) {
      await searchBox.dispose();
    }
  }
}

async function interactiveGoogleSearch(page, query) {
  debug(`Google interactive search: waiting for ${SEARCH_BOX_SELECTOR}`);
  let searchBox;
  try {
    // Google's text control can be covered by decorative/autocomplete layers while
    // remaining focusable. Requiring it to win an elementFromPoint hit test rejects
    // valid search boxes, so only the submit button uses that stricter check.
    searchBox = await waitForVisibleElement(page, SEARCH_BOX_SELECTOR);
  } catch (error) {
    await debugPagePreview(page, "Google interactive search box unavailable");
    throw new Error(
      `Google homepage did not expose a visible search box: ${error.message}`
    );
  }
  try {
    await searchBox.click();
  } finally {
    await searchBox.dispose();
  }

  // Google can replace its textarea while it receives focus. Reacquire the
  // live element, then type through that ElementHandle so Puppeteer focuses
  // the exact control receiving the key events.
  debug("Google interactive search: reacquiring the live search box after click");
  try {
    searchBox = await waitForVisibleElement(page, SEARCH_BOX_SELECTOR);
  } catch (error) {
    await debugPagePreview(page, "Google interactive live search box unavailable");
    throw new Error(
      `Google replaced the search box and no live replacement was found: ${error.message}`
    );
  }
  try {
    await searchBox.focus();
    const focusMatches = await searchBox.evaluate(
      (element) => document.activeElement === element
    );
    debug(`Google interactive search: search_box_focused=${focusMatches}`);
    await searchBox.type(query, { delay: TYPING_DELAY_MS });
  } finally {
    await searchBox.dispose();
  }

  const controlState = await inspectSearchControls(page, query);
  const activeCandidate = controlState.candidates.find(
    (candidate) => candidate.active
  );
  const bestCandidate = controlState.candidates.reduce(
    (best, candidate) =>
      (candidate.value || "").length > (best?.value || "").length
        ? candidate
        : best,
    null
  );
  const typedValue = activeCandidate?.value ?? bestCandidate?.value ?? "";
  debug(
    `Google interactive search: typed_characters=${typedValue.length}; ` +
      `query_matches=${controlState.queryMatch}`
  );
  if (!controlState.queryMatch) {
    debug(
      `Google interactive search control diagnostics: ${JSON.stringify(
        controlState
      )}`
    );
    await debugPagePreview(page, "Google interactive query verification failed");
    throw new Error(
      `Google search box value did not match the requested query: ${JSON.stringify(
        typedValue
      )}`
    );
  }

  debug(`Google interactive search: waiting for ${SEARCH_BUTTON_SELECTOR}`);
  let searchButton;
  try {
    searchButton = await waitForVisibleElement(page, SEARCH_BUTTON_SELECTOR, {
      timeout: SUBMIT_BUTTON_TIMEOUT_MS,
      requireHitTarget: true,
    });
  } catch (error) {
    debug(
      `Google interactive search: no clickable submit button (${error.message}); ` +
        "falling back to Enter"
    );
    return submitGoogleSearchWithEnter(page);
  }
  try {
    debug("Google interactive search: clicking the visible search button");
    const navigationPromise = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    const [response] = await Promise.all([
      navigationPromise,
      searchButton.click(),
    ]);
    return response;
  } finally {
    await searchButton.dispose();
  }
}

async function directGoogleSearch(
  page,
  query,
  regionalSettings = googleRegionalSettings()
) {
  const url =
    `${GOOGLE_SEARCH_URL}?q=${encodeURIComponent(query)}` +
    `&hl=${encodeURIComponent(regionalSettings.language)}` +
    `&gl=${encodeURIComponent(regionalSettings.country)}`;
  debug(`Google navigation URL: ${JSON.stringify(url)}`);
  return page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
}

function navigateGoogleSearch(
  page,
  query,
  { interactive = false, regionalSettings = googleRegionalSettings() } = {}
) {
  return interactive
    ? interactiveGoogleSearch(page, query)
    : directGoogleSearch(page, query, regionalSettings);
}

module.exports = {
  GOOGLE_SEARCH_URL,
  SEARCH_BOX_SELECTOR,
  SEARCH_BUTTON_SELECTOR,
  directGoogleSearch,
  interactiveGoogleSearch,
  inspectSearchControls,
  navigateGoogleSearch,
  submitGoogleSearchWithEnter,
  waitForVisibleElement,
};
