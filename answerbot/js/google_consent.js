const { debug, debugPagePreview } = require("./browser");

const CONSENT_ACTION_SELECTOR =
  'button, input[type="submit"], [role="button"]';
const CONSENT_TIMEOUT_MS = 10000;

// These labels are deliberately explicit: if Google shows an unfamiliar
// localization, failing with diagnostics is safer than clicking an arbitrary
// consent action. The first two cover the project's normal English and
// Romanian environments.
const REJECT_ALL_LABELS = [
  "Reject all",
  "Respinge tot",
  "Alle ablehnen",
  "Tout refuser",
  "Rechazar todo",
  "Rifiuta tutto",
  "Odrzuć wszystko",
  "Recusar tudo",
  "Az összes elutasítása",
];

const CONSENT_MARKERS = [
  "Before you continue to Google",
  "Before you access Google",
  "Înainte de a accesa Google",
  "Bevor Sie zu Google weitergehen",
  "Avant d'accéder à Google",
  "Antes de acceder a Google",
  "Prima di accedere a Google",
  "Zanim przejdziesz do Google",
  "Antes de aceder à Google",
  "Mielőtt továbblép a Google-ra",
];

function normalizeConsentText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizedValues(values) {
  return values.map(normalizeConsentText);
}

async function inspectGoogleConsent(page) {
  return page.evaluate(
    (actionSelector, rejectLabels, consentMarkers) => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const label = (element) =>
        normalize(
          element.getAttribute("aria-label") ||
            element.value ||
            element.textContent
        );
      const isReject = (value) =>
        rejectLabels.some(
          (knownLabel) =>
            value === knownLabel ||
            value.startsWith(`${knownLabel} `) ||
            value.endsWith(` ${knownLabel}`)
        );

      const actions = Array.from(document.querySelectorAll(actionSelector))
        .filter(visible)
        .map((element) => ({
          tagName: element.tagName,
          id: element.id || null,
          name: element.getAttribute("name"),
          ariaLabel: element.getAttribute("aria-label"),
          text: normalize(element.textContent || element.value),
          normalizedLabel: label(element),
        }));
      const rejectControl =
        actions.find((action) => isReject(action.normalizedLabel)) || null;

      const visibleContainers = Array.from(
        document.querySelectorAll('[role="dialog"], [aria-modal="true"], form')
      ).filter(visible);
      const markerFound = visibleContainers.some((container) => {
        const text = normalize(container.innerText || container.textContent);
        return consentMarkers.some((marker) => text.includes(marker));
      });

      return {
        detected: Boolean(rejectControl || markerFound),
        rejectControl,
        visibleActions: actions.slice(0, 20),
      };
    },
    CONSENT_ACTION_SELECTOR,
    normalizedValues(REJECT_ALL_LABELS),
    normalizedValues(CONSENT_MARKERS)
  );
}

async function waitForRejectAllControl(page) {
  const handle = await page.waitForFunction(
    (actionSelector, rejectLabels) => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      return (
        Array.from(document.querySelectorAll(actionSelector)).find((element) => {
          if (!visible(element)) return false;
          const value = normalize(
            element.getAttribute("aria-label") ||
              element.value ||
              element.textContent
          );
          return rejectLabels.some(
            (knownLabel) =>
              value === knownLabel ||
              value.startsWith(`${knownLabel} `) ||
              value.endsWith(` ${knownLabel}`)
          );
        }) || null
      );
    },
    { timeout: CONSENT_TIMEOUT_MS },
    CONSENT_ACTION_SELECTOR,
    normalizedValues(REJECT_ALL_LABELS)
  );
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error("Google Reject all control did not resolve to an ElementHandle");
  }
  return element;
}

async function waitForConsentToClose(page) {
  const handle = await page.waitForFunction(
    (actionSelector, rejectLabels, consentMarkers) => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const rejectStillVisible = Array.from(
        document.querySelectorAll(actionSelector)
      ).some((element) => {
        if (!visible(element)) return false;
        const value = normalize(
          element.getAttribute("aria-label") ||
            element.value ||
            element.textContent
        );
        return rejectLabels.some(
          (knownLabel) =>
            value === knownLabel ||
            value.startsWith(`${knownLabel} `) ||
            value.endsWith(` ${knownLabel}`)
        );
      });
      const consentMarkerStillVisible = Array.from(
        document.querySelectorAll('[role="dialog"], [aria-modal="true"], form')
      )
        .filter(visible)
        .some((container) => {
          const text = normalize(container.innerText || container.textContent);
          return consentMarkers.some((marker) => text.includes(marker));
        });
      return !rejectStillVisible && !consentMarkerStillVisible;
    },
    { timeout: CONSENT_TIMEOUT_MS },
    CONSENT_ACTION_SELECTOR,
    normalizedValues(REJECT_ALL_LABELS),
    normalizedValues(CONSENT_MARKERS)
  );
  await handle.dispose();
}

async function resolveGoogleConsent(page) {
  const initialState = await inspectGoogleConsent(page);
  debug(
    `Google consent check: detected=${initialState.detected}; ` +
      `reject_control=${JSON.stringify(initialState.rejectControl)}; ` +
      `visible_actions=${JSON.stringify(initialState.visibleActions)}`
  );
  if (!initialState.detected) {
    return false;
  }

  if (!initialState.rejectControl) {
    await debugPagePreview(page, "Google consent action unavailable");
    throw new Error(
      "Google consent prompt was detected, but no recognized Reject all control was found"
    );
  }

  let rejectControl;
  try {
    rejectControl = await waitForRejectAllControl(page);
    const label = await rejectControl.evaluate(
      (element) =>
        element.getAttribute("aria-label") ||
        element.value ||
        element.textContent.trim()
    );
    debug(`Google consent: clicking Reject all control ${JSON.stringify(label)}`);
    await rejectControl.click();
  } catch (error) {
    await debugPagePreview(page, "Google consent rejection failed");
    throw new Error(`Could not reject Google consent prompt: ${error.message}`);
  } finally {
    if (rejectControl) {
      await rejectControl.dispose();
    }
  }

  try {
    await waitForConsentToClose(page);
  } catch (error) {
    await debugPagePreview(page, "Google consent prompt remained open");
    throw new Error(`Google consent prompt did not close: ${error.message}`);
  }

  const finalState = await inspectGoogleConsent(page);
  if (finalState.detected) {
    await debugPagePreview(page, "Google consent verification failed");
    throw new Error("Google consent prompt remained visible after Reject all");
  }
  const cookies = await page.cookies();
  debug(
    `Google consent resolved: action=reject_all; final_url=${JSON.stringify(
      page.url()
    )}; cookie_names=${JSON.stringify(cookies.map((cookie) => cookie.name))}`
  );
  return true;
}

module.exports = {
  CONSENT_ACTION_SELECTOR,
  CONSENT_MARKERS,
  REJECT_ALL_LABELS,
  inspectGoogleConsent,
  normalizeConsentText,
  resolveGoogleConsent,
};
