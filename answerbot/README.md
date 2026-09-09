# AnswerBot

This is the project accompany my video about using Puppeteer and and LLM to automate web research: TBD

This project automates web research by using Puppeteer, Google Search, and an LLM.

The project is a combination of Python and JavaScript:

- **Python** is the harness. It orchestrates the flow and talks to the LLM.
- **JavaScript (Node.js)** scripts use Puppeteer to query Google and fetch web pages. The Python harness invokes these scripts and captures their output.

## Flow

1. The user types a question.
2. The LLM is asked to select a good Google query for that question.
3. A Puppeteer script is used to query Google.
4. The LLM is asked to extract the top 5 links from the search results.
5. Puppeteer scripts are used to fetch those pages.
6. The pages are given to the LLM and it generates a summary.

If Google blocks automated queries (CAPTCHA or rate limiting), the search step automatically falls back to DuckDuckGo's lightweight HTML endpoint. The search engine can be forced with `-g` (Google) or `-d` (DuckDuckGo); when forced there is no fallback, so a failed search stops the run with an error. Puppeteer uses the browser's native fingerprint by default. Pass `--stealth` to explicitly enable [puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) for Chrome/Chromium; its static WebGL override remains disabled and Linux is not masked as Windows. `--stealth` is incompatible with Firefox. Before a Google query, the same page visits the Google homepage and briefly waits so Google can establish its initial cookies.

By default only the final answer is printed to stdout, plus a one-line error message on failure. Pass `-v` / `--verbose` to also see step-by-step progress on stderr (chosen query, pages fetched, etc.).

Pass `--debug` for detailed diagnostics on stderr. Debug mode implies verbose mode and reports the configured and effective DataImpulse usernames, a redacted password fingerprint, proxy endpoint and per-attempt session, browser version, pre-navigation and post-Google fingerprints, high-entropy user-agent data, WebGL identity, locale/timezone, screen/window and hardware fields, request headers and redirects, response status and headers, blocked-page previews, and browser egress IP. When proxy credentials are configured, it first checks the normal IP with the credentials removed from that child process, then checks two separate sticky browser attempts. It warns if the proxy IP matches the normal IP or if the two attempts reuse an address. These extra comparisons only run in debug mode. The raw proxy password and HTTP cookies are never printed.

Pass `--headed` to run the browser visibly. Like the supplied DataImpulse script, headed mode launches with `defaultViewport: null`, starts Chrome maximized, and does not call `page.setViewport()`. It uses the native fingerprint unless `--stealth` is also passed. This mode requires an active graphical desktop or display server. Chrome discovery prefers an explicitly configured `PUPPETEER_EXECUTABLE_PATH`, then an installed Google Chrome, then an installed Chromium, and finally Puppeteer's bundled browser. For example:

```
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome python answerbot.py --headed --debug "your question"
```

If Google returns a 429/403 or CAPTCHA page in headed mode, Answerbot keeps that same browser instance, profile, and proxy connection open. Complete the challenge manually in the browser and the search resumes automatically when Google returns to the results page. Close the browser instead to abort. This manual wait has no Python-side timeout; headless searches retain their normal fail-fast timeout.

Pass `--retry` to try up to eight complete Google browser attempts when Google returns a CAPTCHA, 429, or 403. Each failed attempt is closed; the next attempt starts a fresh Node browser process with a new sticky DataImpulse `sessid`, while every connection within that attempt remains on one IP. Retry mode requires both DataImpulse credentials and applies only to Google. In headed retry mode, a blocked window is closed automatically instead of being left open for manual CAPTCHA completion. Non-blocking failures such as invalid proxy credentials still fail immediately. For example:

```
python answerbot.py -g --retry --headed --debug "your question"
python answerbot.py -g --retry -i --stealth --debug "your question"
```

Pass `--firefox` to use Firefox through WebDriver BiDi instead of Chrome. It applies to Google and DuckDuckGo searches, page fetching, egress checks, headed mode, and `--browser`. Firefox uses a separate persistent profile and native fingerprint. Examples:

```
python answerbot.py --firefox --debug "your question"
python answerbot.py --firefox -i --headed --debug "your question"
python answerbot.py --firefox --browser
```

Puppeteer does not download Firefox by default unless configured. This project enables both downloads in `.puppeteerrc.cjs`; after pulling the change, install the compatible browsers with:

```
npm run browsers:install
```

The launcher also detects system Firefox installations at common Linux, Windows, and macOS paths. Set `PUPPETEER_FIREFOX_EXECUTABLE_PATH` to explicitly select another Firefox executable. `PUPPETEER_EXECUTABLE_PATH` remains Chrome-only so an existing Chrome override cannot accidentally be launched as Firefox.

Pass `--stealth` to force the stealth plugin in either headless or headed Chrome. Without the flag, the plugin is not registered. Firefox does not support this Chromium-specific plugin, so `--firefox --stealth` is rejected.

Pass `-i` / `--interactive` to enter the generated query into Google's visible homepage search field and click its submit button. This works in both the default headless mode and with `--headed`. Without this flag, Answerbot keeps the faster direct search-URL navigation. For example:

```
python answerbot.py -g -i --debug "your question"
python answerbot.py -g -i --headed --debug "your question"
```

Google searches use a persistent browser profile. By default it is stored under `.answerbot/google-profile` in the user's home directory, separated by browser and a hash of the effective proxy identity so Chrome, Firefox, direct, and differently targeted proxy sessions do not mix cookies. Existing Chrome profile paths are preserved. Set `ANSWERBOT_GOOGLE_PROFILE_DIR` to use a specific directory instead. Do not point both browsers at the same explicit directory. Answerbot locks the selected profile for the duration of a search and rejects concurrent use; IP checks and fetched result pages continue to use temporary profiles.

To open that exact profile in a normal headed Chrome window for manual use, run:

```
python answerbot.py --browser
```

Browser mode skips the question, LLM, egress checks, and search pipeline. It opens Google with the same browser, base DataImpulse proxy identity, regional settings, and profile directory that automated Google searches use; the browser run receives its own fresh sticky session. Handle consent prompts or challenges manually, browse normally, and then close the browser window; its cookies and other profile state are retained for subsequent searches. The profile lock prevents browser mode and an automated search from using the directory at the same time. `--firefox` selects the Firefox profile; `--debug` and Chrome's `--stealth` may be added for launcher diagnostics or fingerprint behavior; other search-related options have no effect in browser mode.

## AI providers

The LLM can either be OpenAI or a local LLM running via Ollama. The AI provider and model are configurable via command line flags, e.g.:

```
python answerbot.py --provider openai --model gpt-4o-mini
python answerbot.py --provider ollama --model qwen3.5:4b
```

With `--model` omitted, defaults per provider are `gpt-4o-mini` (OpenAI) and `gemma4:e4b` (Ollama). For Ollama, pass a model that is installed locally (see `ollama list`).

## Setup

Prerequisites: Python 3 and Node.js installed on your machine.

The two halves of the project each have a dependency file — install both, from this directory:

- **Python** — `requirements.txt` lists the packages the harness needs (currently just the `openai` SDK, used for both OpenAI and Ollama):

  ```
  pip install -r requirements.txt
  ```

- **Node.js** — `package.json` lists Puppeteer, `puppeteer-extra`, and the optional stealth plugin. `npm install` reads `package.json` and also downloads a compatible Chromium browser:

  ```
  npm install
  ```

Finally, set `OPENAI_API_KEY` in your environment when using the OpenAI provider; nothing extra is needed for Ollama beyond it running locally.

**Linux on ARM**: Google does not publish Chrome for Testing builds for Linux ARM, so Puppeteer's automatic browser download cannot produce a working binary there. The scripts therefore auto-detect a system-installed browser, preferring `PUPPETEER_EXECUTABLE_PATH`, Google Chrome, and then Chromium paths such as `/usr/bin/chromium`, `/usr/bin/chromium-browser`, and `/snap/bin/chromium`. On ARM, install Chromium from your distribution and skip the useless download:

```
sudo apt install chromium          # Debian/Ubuntu (package name may differ elsewhere)
rm -rf ~/.cache/puppeteer          # remove the broken auto-download, if present
PUPPETEER_SKIP_DOWNLOAD=1 npm install
```

On other platforms no configuration is needed; `PUPPETEER_EXECUTABLE_PATH` remains available as an explicit override.

## Proxy (optional)

If `DATAIMPULSE_USERNAME` and `DATAIMPULSE_PASSWORD` are set in the environment, all browser traffic is routed through the DataImpulse residential gateway (`gw.dataimpulse.com:823`). Chrome receives the proxy through its command line; Firefox receives equivalent HTTP/HTTPS proxy preferences, while both use Puppeteer's HTTP-authentication support for credentials. Leave them unset for a direct connection. Credentials come from the "Proxy Access" section of the DataImpulse dashboard.

Each Node browser process generates one fresh `sessid` and uses that same effective username for every connection made during the complete browser attempt. This prevents the homepage, subresources, and results request from being assigned different exits. A later browser process gets a new session and therefore a new opportunity for a clean exit IP. Any configured `sessid`/`sessttl` is replaced; other targeting parameters are preserved. If a `cr` parameter lists multiple countries, the first country is pinned so the browser identity is unambiguous.

Google's region is aligned with that pinned country: the direct results URL receives matching `hl` and `gl`, the browser receives a matching locale and `Accept-Language`, and the page emulates a matching timezone. The default is `cr.us`, `hl=en`, `en-US`, and `America/New_York` when the username has no country. Advanced overrides are available through `ANSWERBOT_GOOGLE_COUNTRY`, `ANSWERBOT_GOOGLE_LANGUAGE`, and `ANSWERBOT_GOOGLE_TIMEZONE`; keep all three mutually consistent. With `-v` / `--verbose`, the harness logs when the proxy is active, and if a network failure occurs while the proxy is enabled the error message points at these credentials.

Set them for the current session — Windows (PowerShell):

```
$env:DATAIMPULSE_USERNAME = "your-login"
$env:DATAIMPULSE_PASSWORD = "your-password"
```

macOS / Linux (bash/zsh):

```
export DATAIMPULSE_USERNAME="your-login"
export DATAIMPULSE_PASSWORD="your-password"
```

DataImpulse gateway reference:

- **823** — HTTP/HTTPS gateway (used with a generated sticky `sessid` by this project)
- **824** — SOCKS5, rotating; **10000–20000** — sticky sessions. Not used here, because Chromium does not support username/password authentication over SOCKS5.
- **Country targeting** — append a suffix to the username, e.g. `DATAIMPULSE_USERNAME=mylogin__cr.us` targets the US.

To verify the browser is actually egressing through the gateway, run `node js/check_ip.js` — it prints the IP the browser is using. With the credentials set it should show a DataImpulse residential IP (compare with the curl check); without them it shows your local IP. With `-v` / `--verbose`, the harness also logs this egress IP automatically at the start of a proxied run.
