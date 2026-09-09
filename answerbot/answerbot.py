import argparse
import hashlib
import json
import os
import platform
import random
import subprocess
import sys
import time
import traceback
from pathlib import Path

from llm_client import DEFAULT_MODELS, chat

JS_DIR = Path(__file__).resolve().parent / "js"
TOP_LINK_COUNT = 5
SEARCH_TIMEOUT_SECONDS = 60
PAGE_TIMEOUT_SECONDS = 120
EGRESS_TIMEOUT_SECONDS = 60
GOOGLE_RETRY_ATTEMPTS = 8
MAX_PAGE_CHARS = 50_000

VERBOSE = False
DEBUG = False
HEADED = False
INTERACTIVE = False
FIREFOX = False
STEALTH = False
RETRY = False


def progress(message):
    if VERBOSE:
        print(message, file=sys.stderr)


def debug(message):
    if DEBUG:
        print(f"[debug] {message}", file=sys.stderr)


PROXY_FAILURE_MARKERS = (
    "net::ERR_TUNNEL_CONNECTION_FAILED",
    "net::ERR_PROXY_AUTHENTICATION_FAILED",
    "net::ERR_PROXY_AUTH_REQUESTED",
    "net::ERR_TIMED_OUT",
    "NS_ERROR_PROXY_AUTHENTICATION_FAILED",
    "NS_ERROR_UNKNOWN_PROXY_HOST",
    "NS_ERROR_NET_TIMEOUT",
)

GOOGLE_BLOCK_MARKERS = (
    "Google responded 429",
    "Google responded 403",
    "Google homepage responded 429",
    "Google homepage responded 403",
    "Google served a CAPTCHA block page",
)


def proxy_enabled():
    return bool(os.environ.get("DATAIMPULSE_USERNAME") and os.environ.get("DATAIMPULSE_PASSWORD"))


def credential_fingerprint(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def report_debug_configuration(provider, model, forced_engine):
    username = os.environ.get("DATAIMPULSE_USERNAME")
    password = os.environ.get("DATAIMPULSE_PASSWORD")
    executable = os.environ.get("PUPPETEER_EXECUTABLE_PATH")
    firefox_executable = os.environ.get("PUPPETEER_FIREFOX_EXECUTABLE_PATH")

    debug(f"Python: {platform.python_version()} ({platform.platform()})")
    debug(f"LLM provider: {provider}; model: {model or DEFAULT_MODELS[provider]}")
    debug(f"Search engine: {forced_engine or 'google with DuckDuckGo fallback'}")
    debug(
        f"Browser: {'firefox' if FIREFOX else 'chrome'}; "
        f"mode: {'headed' if HEADED else 'headless'}"
    )
    debug(f"Google query submission: {'interactive' if INTERACTIVE else 'direct URL'}")
    debug(f"Stealth plugin: {'enabled' if STEALTH else 'disabled'}")
    debug(
        "Google retry policy: "
        + (
            f"up to {GOOGLE_RETRY_ATTEMPTS} fresh browser attempts"
            if RETRY
            else "disabled"
        )
    )
    debug(f"PUPPETEER_EXECUTABLE_PATH: {executable!r}")
    if FIREFOX:
        debug(f"PUPPETEER_FIREFOX_EXECUTABLE_PATH: {firefox_executable!r}")
    debug(f"DATAIMPULSE_USERNAME: {username!r}")
    if password is None:
        debug("DATAIMPULSE_PASSWORD: <unset>")
    else:
        debug(
            "DATAIMPULSE_PASSWORD: "
            f"<redacted; characters={len(password)}; "
            f"utf8_bytes={len(password.encode('utf-8'))}; "
            f"sha256={credential_fingerprint(password)}>"
        )

    if bool(username) != bool(password):
        debug(
            "WARNING: only one DataImpulse credential is non-empty; "
            "the proxy will be disabled."
        )
    elif not proxy_enabled():
        debug("DataImpulse proxy authentication is disabled.")


def ask_llm(prompt, provider, model):
    selected_model = model or DEFAULT_MODELS[provider]
    debug(
        f"LLM request: provider={provider}; model={selected_model}; "
        f"prompt_chars={len(prompt)}"
    )
    started = time.perf_counter()
    reply = chat([{"role": "user", "content": prompt}], provider=provider, model=model)
    debug(
        f"LLM response: elapsed={time.perf_counter() - started:.2f}s; "
        f"reply_chars={len(reply)}; preview={reply[:500]!r}"
    )
    return reply


def run_node_script(script_name, argument, timeout_seconds, env_overrides=None):
    command = ["node", str(JS_DIR / script_name), argument]
    child_env = os.environ.copy()
    if DEBUG:
        child_env["ANSWERBOT_DEBUG"] = "1"
    if HEADED:
        child_env["ANSWERBOT_HEADED"] = "1"
    if INTERACTIVE:
        child_env["ANSWERBOT_INTERACTIVE"] = "1"
    else:
        child_env.pop("ANSWERBOT_INTERACTIVE", None)
    if FIREFOX:
        child_env["ANSWERBOT_FIREFOX"] = "1"
    else:
        child_env.pop("ANSWERBOT_FIREFOX", None)
    if STEALTH:
        child_env["ANSWERBOT_STEALTH"] = "1"
    else:
        child_env.pop("ANSWERBOT_STEALTH", None)
    if RETRY:
        child_env["ANSWERBOT_RETRY"] = "1"
    else:
        child_env.pop("ANSWERBOT_RETRY", None)
    for name, value in (env_overrides or {}).items():
        if value is None:
            child_env.pop(name, None)
        else:
            child_env[name] = value

    timeout_description = (
        "disabled" if timeout_seconds is None else f"{timeout_seconds}s"
    )
    debug(
        f"Starting Node subprocess: script={script_name}; "
        f"argument={argument!r}; timeout={timeout_description}"
    )
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            env=child_env,
        )
    except subprocess.TimeoutExpired:
        debug(
            f"Node subprocess timed out: script={script_name}; "
            f"elapsed={time.perf_counter() - started:.2f}s"
        )
        raise

    elapsed = time.perf_counter() - started
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    debug(
        f"Node subprocess completed: script={script_name}; "
        f"exit_code={completed.returncode}; elapsed={elapsed:.2f}s; "
        f"stdout_chars={len(stdout)}; stderr_chars={len(stderr)}"
    )
    if stderr.strip():
        for line in stderr.rstrip().splitlines():
            debug(f"{script_name} stderr: {line}")
    if stdout.strip():
        preview = stdout.strip()[:1_500]
        suffix = "..." if len(stdout.strip()) > len(preview) else ""
        debug(f"{script_name} stdout preview: {preview!r}{suffix}")

    if completed.returncode != 0:
        detail = stderr.strip()
        message = f"{script_name} failed: {detail}"
        if proxy_enabled() and any(marker in detail for marker in PROXY_FAILURE_MARKERS):
            message += " (proxy authentication may have failed; check DATAIMPULSE_USERNAME/DATAIMPULSE_PASSWORD)"
        raise RuntimeError(message)
    return stdout


def run_manual_browser():
    child_env = os.environ.copy()
    child_env["ANSWERBOT_HEADED"] = "1"
    if FIREFOX:
        child_env["ANSWERBOT_FIREFOX"] = "1"
    else:
        child_env.pop("ANSWERBOT_FIREFOX", None)
    if STEALTH:
        child_env["ANSWERBOT_STEALTH"] = "1"
    else:
        child_env.pop("ANSWERBOT_STEALTH", None)
    if DEBUG:
        child_env["ANSWERBOT_DEBUG"] = "1"

    command = ["node", str(JS_DIR / "manual_browser.js")]
    debug(f"Starting manual browser subprocess: script={command[1]!r}")
    completed = subprocess.run(command, env=child_env)
    if completed.returncode != 0:
        raise RuntimeError(
            f"manual_browser.js failed with exit code {completed.returncode}"
        )
    return completed.returncode


def parse_json_array(reply):
    stripped = reply.strip()
    start = stripped.find("[")
    end = stripped.rfind("]")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"No JSON array found in reply:\n{reply}")
    return json.loads(stripped[start : end + 1])


def choose_search_query(question, provider, model):
    progress("Asking the LLM to choose a Google search query...")
    prompt = (
        "Given this question, reply with exactly one effective Google search "
        "query that should surface pages able to answer it.\n"
        "Reply with the query text only: no quotes, no explanation.\n\n"
        f"Question: {question}"
    )
    return ask_llm(prompt, provider, model).strip().strip('"')


def extract_top_links(question, query, search_results, provider, model):
    progress("Asking the LLM to pick the best links...")
    prompt = (
        f'Below is JSON with results of a Google search for "{query}".\n\n'
        f"{json.dumps(search_results, indent=2)}\n\n"
        f"The goal is to answer this question: {question}\n"
        f"Reply ONLY with a JSON array of up to {TOP_LINK_COUNT} URLs from the "
        "results most likely to help answer it, ordered best-first. "
        'Example: ["https://example.org/a", "https://another.example/b"]'
    )

    links = []
    seen = set()
    try:
        candidates = parse_json_array(ask_llm(prompt, provider, model))
    except (ValueError, json.JSONDecodeError) as exc:
        progress(f"Could not parse link list from LLM ({exc}); using first results.")
        candidates = [result["url"] for result in search_results]

    for url in candidates:
        if isinstance(url, str) and url.startswith(("http://", "https://")) and url not in seen:
            seen.add(url)
            links.append(url)
        if len(links) == TOP_LINK_COUNT:
            break
    return links


def fetch_pages(links):
    pages = []
    for index, link in enumerate(links, start=1):
        progress(f"[{index}/{len(links)}] Fetching {link}")
        try:
            text = run_node_script("fetch_page.js", link, PAGE_TIMEOUT_SECONDS).strip()
        except subprocess.TimeoutExpired:
            progress(f"[{index}/{len(links)}] Skipping {link}: timed out")
            continue
        except RuntimeError as exc:
            progress(f"[{index}/{len(links)}] Skipping {link}: {exc}")
            continue
        if not text:
            progress(f"[{index}/{len(links)}] Skipping {link}: page was empty")
            continue
        progress(f"[{index}/{len(links)}] Fetched {len(text)} chars from {link}")
        pages.append((link, text))
    return pages


def summarize(question, pages, provider, model):
    progress("Asking the LLM to write the final summary...")
    page_blocks = [
        f'== Page {i}: "{url}" ==\n{text[:MAX_PAGE_CHARS]}'
        for i, (url, text) in enumerate(pages, start=1)
    ]
    prompt = (
        "You are a diligent research assistant. Answer the user's question using "
        "the web pages below. Prefer facts grounded in those pages, note any "
        "disagreements between sources, and keep the answer concise.\n\n"
        f"Question: {question}\n\n"
        "Fetched pages:\n\n" + "\n\n".join(page_blocks)
    )
    return ask_llm(prompt, provider, model)


def google_search(query):
    # A headed Google session may remain open indefinitely while the user
    # completes a challenge. Retry mode instead closes a blocked headed attempt
    # so the next Node process receives a fresh sticky proxy session.
    timeout = None if HEADED and not RETRY else SEARCH_TIMEOUT_SECONDS
    attempt_limit = GOOGLE_RETRY_ATTEMPTS if RETRY else 1

    for attempt in range(1, attempt_limit + 1):
        if RETRY:
            progress(f"Google browser attempt {attempt}/{attempt_limit}...")
        try:
            raw = run_node_script("search.js", query, timeout).strip()
            results = json.loads(raw) if raw else []
            if not results:
                raise RuntimeError("Google search returned no results")
            return results
        except RuntimeError as exc:
            blocked = any(marker in str(exc) for marker in GOOGLE_BLOCK_MARKERS)
            if not RETRY or not blocked:
                raise
            if attempt == attempt_limit:
                raise RuntimeError(
                    f"Google was blocked on all {attempt_limit} browser attempts"
                ) from exc

            delay = random.uniform(1.5, 3.5)
            progress(
                f"Google blocked attempt {attempt}/{attempt_limit}; closing that "
                f"browser and retrying with a fresh sticky IP in {delay:.1f}s..."
            )
            time.sleep(delay)

    raise RuntimeError("Google retry loop ended without a result")


def duckduckgo_search(query):
    raw = run_node_script("search_ddg.js", query, SEARCH_TIMEOUT_SECONDS).strip()
    results = json.loads(raw) if raw else []
    if not results:
        raise RuntimeError("DuckDuckGo search returned no results")
    return results


def web_search(query, forced_engine=None):
    if forced_engine is not None:
        name, search_func = (
            ("Google", google_search)
            if forced_engine == "google"
            else ("DuckDuckGo", duckduckgo_search)
        )
        progress(f'Searching {name} for "{query}" (forced; no fallback)...')
        results = search_func(query)
        progress(f"Search returned {len(results)} results")
        return results

    progress(f'Searching Google for "{query}"...')
    try:
        search_results = google_search(query)
    except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        progress(f"Google search failed: {exc}")
        progress("Falling back to DuckDuckGo...")
        search_results = duckduckgo_search(query)
    progress(f"Search returned {len(search_results)} results")
    return search_results


def report_proxy_egress():
    direct_ip = None
    if DEBUG and proxy_enabled():
        debug(
            "Checking normal egress with DataImpulse credentials removed from "
            "the IP-check subprocess."
        )
        try:
            direct_ip = run_node_script(
                "check_ip.js",
                "",
                EGRESS_TIMEOUT_SECONDS,
                env_overrides={
                    "DATAIMPULSE_USERNAME": None,
                    "DATAIMPULSE_PASSWORD": None,
                },
            ).strip()
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            progress(f"Could not verify direct browser egress IP: {exc}")
        if direct_ip:
            progress(f"Browser egress IP (direct, proxy bypassed): {direct_ip}")

    ips = []
    check_count = 2 if DEBUG and proxy_enabled() else 1
    for check_number in range(1, check_count + 1):
        try:
            ip = run_node_script("check_ip.js", "", EGRESS_TIMEOUT_SECONDS).strip()
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            progress(f"Could not verify browser egress IP: {exc}")
            return
        if ip:
            ips.append(ip)
            debug(f"Egress check {check_number}/{check_count}: {ip}")

    if ips:
        label = "proxied" if proxy_enabled() else "direct"
        progress(f"Browser egress IP ({label}): {ips[0]}")
    if len(ips) > 1:
        if len(set(ips)) == 1:
            debug(
                "WARNING: separate sticky browser attempts returned the same "
                "egress IP."
            )
        else:
            debug(
                "Fresh sticky browser attempts used different egress IPs: "
                + ", ".join(ips)
            )
    if direct_ip and ips:
        if direct_ip == ips[0]:
            debug(
                "WARNING: proxied egress matches the normal direct IP; the proxy "
                "does not appear to be changing browser egress."
            )
        else:
            debug(
                f"Egress comparison: direct={direct_ip}; proxied={ips[0]}; "
                "proxy_changed_ip=yes"
            )


def run_pipeline(question, provider, model, forced_engine=None):
    if DEBUG:
        report_debug_configuration(provider, model, forced_engine)
    if proxy_enabled():
        progress(
            "Using DataImpulse sticky proxy per browser attempt "
            "(gw.dataimpulse.com:823)"
        )
        report_proxy_egress()
    elif DEBUG:
        debug("Checking direct browser egress because the proxy is disabled.")
        report_proxy_egress()
    query = choose_search_query(question, provider, model)
    search_results = web_search(query, forced_engine)

    links = extract_top_links(question, query, search_results, provider, model)
    if not links:
        raise RuntimeError("No usable links were selected from the search results.")
    progress(f"Selected links: {', '.join(links)}")

    pages = fetch_pages(links)
    if not pages:
        raise RuntimeError("None of the selected pages could be fetched.")

    return summarize(question, pages, provider, model)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Automated web research: an LLM picks a Google query, "
        "Puppeteer fetches the pages, and an LLM summarizes them."
    )
    parser.add_argument(
        "question",
        nargs="?",
        help="The question you want answered (not used with --browser).",
    )
    parser.add_argument(
        "--browser",
        action="store_true",
        help=(
            "Open a headed browser window with the same persistent Google profile "
            "and proxy identity used by searches, without running the research pipeline."
        ),
    )
    parser.add_argument(
        "--provider",
        choices=("openai", "ollama"),
        default="openai",
        help="AI provider to use (default: openai).",
    )
    parser.add_argument(
        "--model",
        default=None,
        help=f"Model name. Defaults per provider: openai={DEFAULT_MODELS['openai']}, "
        f"ollama={DEFAULT_MODELS['ollama']}.",
    )
    engine_group = parser.add_mutually_exclusive_group()
    engine_group.add_argument(
        "-g",
        "--google",
        dest="engine",
        action="store_const",
        const="google",
        help="Force Google for the web search; no fallback on failure.",
    )
    engine_group.add_argument(
        "-d",
        "--duckduckgo",
        dest="engine",
        action="store_const",
        const="duckduckgo",
        help="Force DuckDuckGo for the web search; no fallback on failure.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show progress messages on stderr while running.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help=(
            "Show detailed browser, proxy, HTTP, timing, and subprocess diagnostics "
            "on stderr. Implies --verbose; passwords remain redacted."
        ),
    )
    parser.add_argument(
        "-i",
        "--interactive",
        action="store_true",
        help=(
            "Enter Google queries through the homepage search box and click submit "
            "instead of navigating directly to a search URL."
        ),
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help=(
            "Run Chrome/Chromium visibly instead of headless. Requires a graphical "
            "desktop or display server."
        ),
    )
    parser.add_argument(
        "--firefox",
        action="store_true",
        help=(
            "Use Firefox through WebDriver BiDi instead of Chrome. Firefox must "
            "be installed by Puppeteer or available as a system browser."
        ),
    )
    parser.add_argument(
        "--stealth",
        action="store_true",
        help=(
            "Force puppeteer-extra-plugin-stealth for Chrome/Chromium. "
            "By default the plugin is not used."
        ),
    )
    parser.add_argument(
        "--retry",
        action="store_true",
        help=(
            f"Retry Google CAPTCHA/429 failures in up to {GOOGLE_RETRY_ATTEMPTS} "
            "fresh browser processes, each with a new sticky proxy session."
        ),
    )
    args = parser.parse_args()
    if not args.browser and not args.question:
        parser.error("question is required unless --browser is used")
    if args.firefox and args.stealth:
        parser.error("--stealth is only supported with Chrome/Chromium, not Firefox")
    if not args.browser and args.retry and args.engine == "duckduckgo":
        parser.error("--retry applies to Google and cannot be used with --duckduckgo")
    if not args.browser and args.retry and not proxy_enabled():
        parser.error(
            "--retry requires DATAIMPULSE_USERNAME and DATAIMPULSE_PASSWORD so "
            "each browser attempt can use a fresh IP"
        )
    return args


def main():
    global DEBUG, FIREFOX, HEADED, INTERACTIVE, RETRY, STEALTH, VERBOSE
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    args = parse_args()
    DEBUG = args.debug
    HEADED = args.headed
    INTERACTIVE = args.interactive
    FIREFOX = args.firefox
    STEALTH = args.stealth
    RETRY = args.retry
    VERBOSE = args.verbose or DEBUG
    try:
        if args.browser:
            HEADED = True
            return run_manual_browser()
        answer = run_pipeline(args.question, args.provider, args.model, args.engine)
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        if VERBOSE:
            traceback.print_exc()
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(answer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
