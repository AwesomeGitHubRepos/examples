const {
  configureRegionalPage,
  debug,
} = require("./browser");

const MAX_RESULTS = 5;
const REDIRECT_TIMEOUT_MS = 4000;

function isGoogleUrl(url) {
  return /(^|\.)google\.[a-z.]+$/i.test(url.hostname);
}

function externalHttpUrl(value, baseUrl) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return isGoogleUrl(url) ? null : url.href;
  } catch (error) {
    return null;
  }
}

function normalizeGoogleResultCandidate(candidate, baseUrl = "https://www.google.com/") {
  const title = String(candidate && candidate.title ? candidate.title : "").trim();
  const href = String(candidate && candidate.href ? candidate.href : "").trim();
  if (!title || !href) return null;

  let parsed;
  try {
    parsed = new URL(href, baseUrl);
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  if (!isGoogleUrl(parsed)) {
    return { title, url: parsed.href, redirect: false };
  }

  // Older result pages expose the destination in /url?q=https://... while
  // newer pages can use /url?url=https://.... Only accept an actual external
  // URL here; current Google pages may put an opaque CAES token in `url`.
  if (/\/url$/i.test(parsed.pathname)) {
    for (const parameter of ["q", "url"]) {
      const destination = externalHttpUrl(parsed.searchParams.get(parameter), parsed.href);
      if (destination) {
        return { title, url: destination, redirect: false };
      }
    }
  }

  // Google currently emits links such as /goto?url=CAES..., whose opaque
  // token cannot be decoded locally. Preserve these so the live browser can
  // follow Google's redirect and reveal the destination URL.
  if (/\/(?:goto|url)$/i.test(parsed.pathname)) {
    return { title, url: parsed.href, redirect: true };
  }

  return null;
}

function finalExternalUrl(response, page) {
  const candidates = [];
  if (response && typeof response.url === "function") {
    candidates.push(response.url());
  }
  if (page && typeof page.url === "function") {
    candidates.push(page.url());
  }
  for (const candidate of candidates) {
    const url = externalHttpUrl(candidate, "https://www.google.com/");
    if (url) return url;
  }
  return null;
}

async function collectGoogleResultCandidates(page) {
  const rawCandidates = await page.evaluate(() => {
    const candidates = [];
    document.querySelectorAll("#search h3, #rso h3").forEach((heading) => {
      const container = heading.closest(".yuRUbf, [data-snf], [data-snhf]");
      const anchor =
        heading.closest("a[href]") ||
        (container ? container.querySelector("a[href]") : null);
      if (!anchor) return;
      candidates.push({
        title: heading.textContent || "",
        href: anchor.href || anchor.getAttribute("href") || "",
      });
    });
    return candidates;
  });

  const baseUrl = typeof page.url === "function" ? page.url() : undefined;
  const candidates = [];
  const seen = new Set();
  for (const rawCandidate of rawCandidates) {
    const candidate = normalizeGoogleResultCandidate(rawCandidate, baseUrl);
    if (!candidate || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    candidates.push(candidate);
  }
  return candidates;
}

async function extractGoogleResults(
  page,
  {
    auth = null,
    regionalSettings,
    configurePage = configureRegionalPage,
    maxResults = MAX_RESULTS,
    redirectTimeout = REDIRECT_TIMEOUT_MS,
  } = {}
) {
  const candidates = await collectGoogleResultCandidates(page);
  debug(
    `Google result candidates: total=${candidates.length}; ` +
      `opaque_redirects=${candidates.filter((candidate) => candidate.redirect).length}`
  );

  const results = [];
  const seen = new Set();
  let resolverPage = null;
  const referrer = typeof page.url === "function" ? page.url() : undefined;

  try {
    for (const candidate of candidates) {
      if (results.length >= maxResults) break;

      let destination = candidate.redirect ? null : candidate.url;
      if (candidate.redirect) {
        try {
          if (!resolverPage) {
            resolverPage = await page.browser().newPage();
            if (auth) await resolverPage.authenticate(auth);
            await configurePage(resolverPage, regionalSettings);
          }

          debug(`Resolving opaque Google result link: ${JSON.stringify(candidate.title)}`);
          let response = null;
          try {
            response = await resolverPage.goto(candidate.url, {
              waitUntil: "domcontentloaded",
              timeout: redirectTimeout,
              ...(referrer ? { referer: referrer } : {}),
            });
          } catch (error) {
            // The destination may be known even when its document times out or
            // aborts, so inspect the response/page URL before discarding it.
            debug(
              `Opaque Google result navigation did not complete: ${String(error)}`
            );
          }
          destination = finalExternalUrl(response, resolverPage);
          if (destination) {
            debug(`Resolved Google result destination: ${JSON.stringify(destination)}`);
          } else {
            debug(
              `Could not resolve opaque Google result link: ${JSON.stringify(
                candidate.url
              )}`
            );
          }
        } catch (error) {
          debug(`Could not prepare Google result resolver page: ${String(error)}`);
        }
      }

      if (!destination || seen.has(destination)) continue;
      seen.add(destination);
      results.push({ title: candidate.title, url: destination });
    }
  } finally {
    if (resolverPage) {
      await resolverPage.close().catch(() => {});
    }
  }

  return results;
}

module.exports = {
  collectGoogleResultCandidates,
  extractGoogleResults,
  finalExternalUrl,
  normalizeGoogleResultCandidate,
};
