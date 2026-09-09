const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

function installedChromePath(base) {
  return base
    ? path.join(base, "Google", "Chrome", "Application", "chrome.exe")
    : null;
}

function installedFirefoxPath(base) {
  return base ? path.join(base, "Mozilla Firefox", "firefox.exe") : null;
}

function selectedBrowser() {
  return process.env.ANSWERBOT_FIREFOX === "1" ? "firefox" : "chrome";
}

function browserExecutableCandidates(browserName = selectedBrowser()) {
  if (browserName === "firefox") {
    return [
      process.env.PUPPETEER_FIREFOX_EXECUTABLE_PATH,
      "/usr/bin/firefox",
      "/usr/bin/firefox-esr",
      "/snap/bin/firefox",
      installedFirefoxPath(process.env.PROGRAMFILES),
      installedFirefoxPath(process.env["PROGRAMFILES(X86)"]),
      "/Applications/Firefox.app/Contents/MacOS/firefox",
    ].filter(Boolean);
  }

  return [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    installedChromePath(process.env.PROGRAMFILES),
    installedChromePath(process.env["PROGRAMFILES(X86)"]),
    installedChromePath(process.env.LOCALAPPDATA),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
}

const PROXY_SERVER = "http://gw.dataimpulse.com:823";
const PROXY_HOST = "gw.dataimpulse.com";
const PROXY_PORT = 823;
const DEBUG = process.env.ANSWERBOT_DEBUG === "1";
const SESSION_PARAMETER_PATTERN = /^(sessid|sessttl)(?:\.|$)/i;
const PROFILE_LOCK_FILENAME = ".answerbot-profile.lock";
const ATTEMPT_SESSION_ID = crypto.randomBytes(4).toString("hex");

const REGION_BY_COUNTRY = {
  us: { locale: "en-US", timezone: "America/New_York" },
  ca: { locale: "en-CA", timezone: "America/Toronto" },
  mx: { locale: "es-MX", timezone: "America/Mexico_City" },
  br: { locale: "pt-BR", timezone: "America/Sao_Paulo" },
  ar: { locale: "es-AR", timezone: "America/Argentina/Buenos_Aires" },
  gb: { locale: "en-GB", timezone: "Europe/London" },
  uk: { locale: "en-GB", timezone: "Europe/London" },
  ie: { locale: "en-IE", timezone: "Europe/Dublin" },
  de: { locale: "de-DE", timezone: "Europe/Berlin" },
  fr: { locale: "fr-FR", timezone: "Europe/Paris" },
  es: { locale: "es-ES", timezone: "Europe/Madrid" },
  it: { locale: "it-IT", timezone: "Europe/Rome" },
  nl: { locale: "nl-NL", timezone: "Europe/Amsterdam" },
  be: { locale: "nl-BE", timezone: "Europe/Brussels" },
  pl: { locale: "pl-PL", timezone: "Europe/Warsaw" },
  ua: { locale: "uk-UA", timezone: "Europe/Kyiv" },
  tr: { locale: "tr-TR", timezone: "Europe/Istanbul" },
  se: { locale: "sv-SE", timezone: "Europe/Stockholm" },
  ch: { locale: "de-CH", timezone: "Europe/Zurich" },
  at: { locale: "de-AT", timezone: "Europe/Vienna" },
  cz: { locale: "cs-CZ", timezone: "Europe/Prague" },
  ro: { locale: "ro-RO", timezone: "Europe/Bucharest" },
  za: { locale: "en-ZA", timezone: "Africa/Johannesburg" },
  ae: { locale: "ar-AE", timezone: "Asia/Dubai" },
  in: { locale: "hi-IN", timezone: "Asia/Kolkata" },
  sg: { locale: "en-SG", timezone: "Asia/Singapore" },
  id: { locale: "id-ID", timezone: "Asia/Jakarta" },
  jp: { locale: "ja-JP", timezone: "Asia/Tokyo" },
  kr: { locale: "ko-KR", timezone: "Asia/Seoul" },
  hk: { locale: "zh-HK", timezone: "Asia/Hong_Kong" },
  au: { locale: "en-AU", timezone: "Australia/Sydney" },
  nz: { locale: "en-NZ", timezone: "Pacific/Auckland" },
};

function debug(message) {
  if (DEBUG) {
    console.error(`[debug] ${message}`);
  }
}

function passwordDescription(password) {
  if (password === undefined) return "<unset>";
  const fingerprint = crypto
    .createHash("sha256")
    .update(password, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `<redacted; characters=${password.length}; utf8_bytes=${Buffer.byteLength(
    password,
    "utf8"
  )}; sha256=${fingerprint}>`;
}

function withoutSessionParameters(username) {
  if (!username) return username;
  const separatorIndex = username.indexOf("__");
  if (separatorIndex === -1) return username;

  const login = username.slice(0, separatorIndex);
  const parameters = username
    .slice(separatorIndex + 2)
    .split(";")
    .filter((parameter) => parameter && !SESSION_PARAMETER_PATTERN.test(parameter));
  return parameters.length ? `${login}__${parameters.join(";")}` : login;
}

function configuredProxyCountry(username = process.env.DATAIMPULSE_USERNAME) {
  if (!username) return null;
  const separatorIndex = username.indexOf("__");
  if (separatorIndex === -1) return null;
  const countryParameter = username
    .slice(separatorIndex + 2)
    .split(";")
    .find((parameter) => /^cr\./i.test(parameter));
  if (!countryParameter) return null;
  const countries = countryParameter.slice(countryParameter.indexOf(".") + 1);
  return countries.split(",")[0].trim().toLowerCase() || null;
}

function googleRegionalSettings(username = process.env.DATAIMPULSE_USERNAME) {
  const country = String(
    process.env.ANSWERBOT_GOOGLE_COUNTRY ||
      configuredProxyCountry(username) ||
      "us"
  ).toLowerCase();
  const defaults = REGION_BY_COUNTRY[country] || REGION_BY_COUNTRY.us;
  const locale = process.env.ANSWERBOT_GOOGLE_LANGUAGE || defaults.locale;
  const language = locale.split("-")[0].toLowerCase();
  const timezone = process.env.ANSWERBOT_GOOGLE_TIMEZONE || defaults.timezone;
  return {
    country,
    locale,
    language,
    timezone,
    acceptLanguage:
      language === locale
        ? locale
        : `${locale},${language};q=0.9`,
  };
}

function withStickyAttemptSession(username, sessionId = ATTEMPT_SESSION_ID) {
  if (!username) return username;
  const regionalSettings = googleRegionalSettings(username);
  const sessionlessUsername = withoutSessionParameters(username);
  const separatorIndex = sessionlessUsername.indexOf("__");
  const login =
    separatorIndex === -1
      ? sessionlessUsername
      : sessionlessUsername.slice(0, separatorIndex);
  const existingParameters =
    separatorIndex === -1
      ? []
      : sessionlessUsername
          .slice(separatorIndex + 2)
          .split(";")
          .filter(Boolean);
  const parameters = existingParameters.filter(
    (parameter) => !/^cr\./i.test(parameter)
  );
  parameters.unshift(`cr.${regionalSettings.country}`);
  parameters.push(`sessid.${sessionId}`);
  return `${login}__${parameters.join(";")}`;
}

function proxyAuth({ stickyAttempt = false } = {}) {
  const configuredUsername = process.env.DATAIMPULSE_USERNAME;
  const username = stickyAttempt
    ? withStickyAttemptSession(configuredUsername)
    : configuredUsername;
  const password = process.env.DATAIMPULSE_PASSWORD;
  if (username && password) {
    return { username, password };
  }
  return null;
}

function googleProfilePath(proxyOptions = {}) {
  const configuredPath = process.env.ANSWERBOT_GOOGLE_PROFILE_DIR;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  const auth = proxyAuth(proxyOptions);
  const connectionIdentity = auth
    ? `proxy:${withoutSessionParameters(auth.username)}`
    : "direct";
  // Preserve existing Chrome profile paths while ensuring Firefox never tries
  // to interpret a Chrome profile directory.
  const identity =
    selectedBrowser() === "firefox"
      ? `firefox:${connectionIdentity}`
      : connectionIdentity;
  const identityHash = crypto
    .createHash("sha256")
    .update(identity, "utf8")
    .digest("hex")
    .slice(0, 12);
  return path.join(os.homedir(), ".answerbot", "google-profile", identityHash);
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function acquireProfileLock(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = path.join(profileDir, PROFILE_LOCK_FILENAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      const token = crypto.randomBytes(16).toString("hex");
      const lockData = JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(descriptor, lockData, "utf8");
      fs.closeSync(descriptor);
      descriptor = undefined;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (current.token === token) {
            fs.unlinkSync(lockPath);
          }
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            debug(`Could not release browser profile lock: ${String(error)}`);
          }
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
      if (!error || error.code !== "EEXIST") throw error;

      let lockData = null;
      try {
        lockData = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch (readError) {
        debug(`Treating unreadable browser profile lock as stale: ${String(readError)}`);
      }

      if (lockData && processIsRunning(Number(lockData.pid))) {
        throw new Error(
          `Google browser profile is already in use by process ${lockData.pid}: ${profileDir}`
        );
      }

      try {
        fs.unlinkSync(lockPath);
        debug(`Removed stale browser profile lock: ${lockPath}`);
      } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }

  throw new Error(`Could not acquire Google browser profile lock: ${profileDir}`);
}

function launchOptions(proxyOptions = {}) {
  const headed = process.env.ANSWERBOT_HEADED === "1";
  const browserName = selectedBrowser();
  const options = {
    browser: browserName,
    headless: !headed,
    ...(headed ? { defaultViewport: null } : {}),
  };
  const regionalSettings = googleRegionalSettings();
  let selectedExecutable = null;
  for (const executablePath of browserExecutableCandidates(browserName)) {
    if (fs.existsSync(executablePath)) {
      options.executablePath = executablePath;
      selectedExecutable = executablePath;
      break;
    }
  }
  const auth = proxyAuth(proxyOptions);
  debug(
    `Browser: ${browserName}; executable: ${
      selectedExecutable ? JSON.stringify(selectedExecutable) : "Puppeteer bundled browser"
    }`
  );
  debug(`Browser mode: ${headed ? "headed" : "headless"}`);
  if (headed) {
    debug(
      `Headed viewport: defaultViewport=null; ` +
        `start_maximized=${browserName === "chrome" ? "yes" : "browser native"}`
    );
  }
  debug(
    `DATAIMPULSE_USERNAME (configured): ${JSON.stringify(
      process.env.DATAIMPULSE_USERNAME
    )}`
  );
  debug(
    `DATAIMPULSE_USERNAME (effective): ${JSON.stringify(
      auth ? auth.username : undefined
    )}`
  );
  debug(
    `DATAIMPULSE_PASSWORD: ${passwordDescription(
      process.env.DATAIMPULSE_PASSWORD
    )}`
  );
  debug(`Regional settings: ${JSON.stringify(regionalSettings)}`);
  if (auth) {
    if (browserName === "firefox") {
      options.extraPrefsFirefox = {
        "intl.accept_languages": regionalSettings.acceptLanguage,
        "intl.locale.requested": regionalSettings.locale,
        "network.proxy.type": 1,
        "network.proxy.http": PROXY_HOST,
        "network.proxy.http_port": PROXY_PORT,
        "network.proxy.ssl": PROXY_HOST,
        "network.proxy.ssl_port": PROXY_PORT,
        "network.proxy.share_proxy_settings": true,
        "network.proxy.no_proxies_on": "",
      };
    } else {
      options.args = [
        `--proxy-server=${PROXY_SERVER}`,
        `--lang=${regionalSettings.locale}`,
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-sync",
        ...(headed ? ["--start-maximized"] : []),
      ];
    }
    debug(
      `Proxy enabled: server=${PROXY_SERVER}; mode=${
        proxyOptions.stickyAttempt
          ? `sticky browser attempt (session=${ATTEMPT_SESSION_ID})`
          : "configured"
      }; browser=${browserName}`
    );
  } else {
    debug("Proxy disabled: both non-empty DataImpulse credentials are required.");
    if (browserName === "firefox") {
      options.extraPrefsFirefox = {
        "intl.accept_languages": regionalSettings.acceptLanguage,
        "intl.locale.requested": regionalSettings.locale,
      };
    } else {
      options.args = [
        `--lang=${regionalSettings.locale}`,
        ...(headed ? ["--start-maximized"] : []),
      ];
    }
  }
  if (proxyOptions.persistentProfile) {
    options.userDataDir = googleProfilePath(proxyOptions);
    debug(`Persistent browser profile: ${JSON.stringify(options.userDataDir)}`);
  } else {
    debug("Browser profile: temporary");
  }
  return options;
}

async function configureRegionalPage(page, settings = googleRegionalSettings()) {
  await page.setExtraHTTPHeaders({
    "Accept-Language": settings.acceptLanguage,
  });
  await page.emulateTimezone(settings.timezone);
  debug(
    `Page region configured: hl=${settings.language}; gl=${settings.country}; ` +
      `locale=${settings.locale}; timezone=${settings.timezone}; ` +
      `accept_language=${JSON.stringify(settings.acceptLanguage)}`
  );
  return settings;
}

async function configureViewport(page, viewport = { width: 1280, height: 800 }) {
  if (process.env.ANSWERBOT_HEADED === "1") {
    debug(
      "Headed mode: retaining the browser's native viewport and window dimensions."
    );
    return false;
  }

  await page.setViewport(viewport);
  debug(`Headless viewport: ${JSON.stringify(viewport)}`);
  return true;
}

function useStealth(puppeteer, stealthPluginFactory) {
  if (process.env.ANSWERBOT_STEALTH !== "1") {
    debug("Stealth plugin disabled (enable explicitly with --stealth).");
    return false;
  }
  if (selectedBrowser() === "firefox") {
    throw new Error("The stealth plugin is Chromium-only and cannot be used with Firefox");
  }

  const stealth = stealthPluginFactory();
  stealth.enabledEvasions.delete("user-agent-override");
  stealth.enabledEvasions.delete("webgl.vendor");
  puppeteer.use(stealth);

  const userAgentOverride = require(
    "puppeteer-extra-plugin-stealth/evasions/user-agent-override"
  );
  puppeteer.use(userAgentOverride({ maskLinux: false }));
  debug(
    "Stealth plugin explicitly enabled; native WebGL is preserved and Linux is not masked."
  );
  return true;
}

function safeRequestDetails(request) {
  const safely = (callback, fallback = null) => {
    try {
      return callback();
    } catch (error) {
      return fallback;
    }
  };
  return {
    method: safely(() => request.method()),
    resourceType: safely(() => request.resourceType()),
    navigationRequest: safely(() => request.isNavigationRequest()),
    url: safely(() => request.url()),
    headers: sanitizedHeaders(safely(() => request.headers(), {})),
  };
}

async function debugBrowser(browser, page, label = "Browser fingerprint") {
  if (!DEBUG) return;
  const fingerprint = await page.evaluate(async () => {
    const userAgentData = navigator.userAgentData;
    let highEntropyValues = null;
    let highEntropyError = null;
    if (userAgentData && typeof userAgentData.getHighEntropyValues === "function") {
      try {
        highEntropyValues = await userAgentData.getHighEntropyValues([
          "architecture",
          "bitness",
          "formFactors",
          "fullVersionList",
          "model",
          "platformVersion",
          "uaFullVersion",
          "wow64",
        ]);
      } catch (error) {
        highEntropyError = String(error);
      }
    }

    let webgl = null;
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (context) {
        const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
        webgl = {
          vendor: debugInfo
            ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
            : null,
          renderer: debugInfo
            ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            : null,
          version: context.getParameter(context.VERSION),
          shadingLanguageVersion: context.getParameter(
            context.SHADING_LANGUAGE_VERSION
          ),
        };
      }
    } catch (error) {
      webgl = { error: String(error) };
    }

    return {
      origin: location.origin,
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: navigator.languages,
      webdriver: navigator.webdriver,
      cookieEnabled: navigator.cookieEnabled,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      userAgentData: userAgentData
        ? {
            brands: userAgentData.brands,
            mobile: userAgentData.mobile,
            platform: userAgentData.platform,
            highEntropyValues,
            highEntropyError,
          }
        : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      window: {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
      },
      webgl,
    };
  });
  debug(`Browser version: ${await browser.version()}`);
  debug(`${label}: ${JSON.stringify(fingerprint)}`);
}

function sanitizedHeaders(headers) {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/authorization|cookie|proxy-authenticate/i.test(name)) {
      sanitized[name] = "<redacted>";
    } else {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function debugResponse(response, label) {
  if (!DEBUG) return;
  if (!response) {
    debug(`${label} response: <none>`);
    return;
  }
  const request = response.request();
  let redirectChain = [];
  try {
    redirectChain = request.redirectChain();
  } catch (error) {
    debug(`Response redirect chain unavailable: ${String(error)}`);
  }
  const requestChain = [...redirectChain, request].map(safeRequestDetails);
  const remoteAddress =
    typeof response.remoteAddress === "function" ? response.remoteAddress() : null;
  debug(
    `${label} response: status=${response.status()}; url=${JSON.stringify(
      response.url()
    )}; remote_address=${JSON.stringify(remoteAddress)}; ` +
      `headers=${JSON.stringify(sanitizedHeaders(response.headers()))}`
  );
  debug(`${label} request chain: ${JSON.stringify(requestChain)}`);
}

async function debugPagePreview(page, label, maxLength = 2_000) {
  if (!DEBUG) return;
  const details = await page
    .evaluate((limit) => {
      const body = document.body ? document.body.innerText : "";
      return {
        title: document.title,
        url: location.href,
        body: body.slice(0, limit),
      };
    }, maxLength)
    .catch((error) => ({ evaluationError: String(error) }));
  debug(`${label} page preview: ${JSON.stringify(details)}`);
}

module.exports = {
  acquireProfileLock,
  configuredProxyCountry,
  browserExecutableCandidates,
  configureRegionalPage,
  configureViewport,
  debug,
  debugBrowser,
  debugPagePreview,
  debugResponse,
  googleProfilePath,
  googleRegionalSettings,
  launchOptions,
  proxyAuth,
  safeRequestDetails,
  selectedBrowser,
  useStealth,
  withStickyAttemptSession,
  withoutSessionParameters,
};
