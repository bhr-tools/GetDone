"""End-to-end test of the offline mode (see the offline plan).

Run after smoke.py on the same instance (the password is already set): a
change made without network is shown at once, survives a reload, and reaches
the server, then another device, when the connection returns.
"""
import os
import sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:18080")
OUT = os.environ.get("OUT", "tests/e2e/out")
PASSWORD = "correct horse"
errors = []
pages = []  # to take a screenshot when the scenario fails
offline = False  # failed requests are expected while the network is cut


def watch(page):
    def on_console(m):
        if m.type in ("error", "warning") and "ERR_INTERNET_DISCONNECTED" not in m.text:
            errors.append(f"console {m.type}: {m.text}")

    def on_failed(r):
        # A sync cut short by a reload is normal: the change stays queued.
        aborted = "/api/sync" in r.url and "ERR_ABORTED" in (r.failure or "")
        if not offline and not aborted:
            errors.append(f"request failed: {r.url} {r.failure}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"page error: {e}"))
    page.on("requestfailed", on_failed)


def shot(page, name):
    page.wait_for_timeout(250)
    page.screenshot(path=f"{OUT}/{name}.png")


def add_inline(page, text):
    page.locator(".composer-title").fill(text)
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)


def login(page):
    page.goto(BASE)
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Unlock").click()
    # The title is in the static HTML: wait for the dialog to go and the list to render.
    expect(page.locator(".auth")).to_have_count(0)
    expect(page.locator("#tasks .add-task").first).to_be_visible()


def rows(page, text):
    return page.locator("#tasks .task-row", has_text=text)


def scenario(browser):
    global offline
    ctx = browser.new_context(viewport={"width": 1280, "height": 820}, timezone_id="Europe/Paris")
    page = ctx.new_page()
    pages.append(page)
    watch(page)
    login(page)

    # The service worker must control the page, or a reload would fail offline.
    page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    page.reload()
    expect(page.locator("#tasks .add-task").first).to_be_visible()
    assert page.evaluate("Boolean(navigator.serviceWorker.controller)"), "page not controlled by the service worker"

    page.locator(".add-task").first.click()
    add_inline(page, "Before offline")
    page.keyboard.press("Escape")
    expect(rows(page, "Before offline")).to_have_count(1)
    expect(page.locator("#status-sync")).to_be_hidden(timeout=10000)  # sent

    # Cut the network: add a task and complete another.
    offline = True
    ctx.set_offline(True)
    page.locator(".add-task").first.click()
    add_inline(page, "Offline task")
    page.keyboard.press("Escape")
    rows(page, "Before offline").locator(".task-check").click()
    expect(rows(page, "Offline task")).to_have_count(1)
    expect(rows(page, "Before offline")).to_have_count(0)
    expect(page.locator("#status-sync")).to_contain_text("offline")
    expect(page.locator("#status-sync")).to_contain_text("2 pending")
    shot(page, "offline-1")

    # The app starts without network, with the local data and the queue.
    page.reload()
    expect(page.locator("#tasks .add-task").first).to_be_visible()
    expect(rows(page, "Offline task")).to_have_count(1)
    expect(rows(page, "Before offline")).to_have_count(0)
    expect(page.locator("#status-sync")).to_contain_text("2 pending")

    # Back online: the queue is sent.
    ctx.set_offline(False)
    offline = False
    page.evaluate("window.dispatchEvent(new Event('online'))")
    expect(page.locator("#status-sync")).to_be_hidden(timeout=10000)
    titles = ctx.request.get(f"{BASE}/api/tasks?view=inbox").text()
    assert "Offline task" in titles, titles
    assert "Before offline" not in titles, titles
    shot(page, "offline-2")

    # Another device sees it.
    other = browser.new_context(viewport={"width": 1280, "height": 820}, timezone_id="Europe/Paris")
    page2 = other.new_page()
    watch(page2)
    login(page2)
    expect(rows(page2, "Offline task")).to_have_count(1)
    other.close()
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    failed = False
    try:
        scenario(browser)
        print("offline: ok")
    except Exception as exc:
        failed = True
        print(f"offline: FAILED: {exc}")
        for i, pg in enumerate(pages):
            pg.screenshot(path=f"{OUT}/offline-failed-{i}.png")
    browser.close()
    for e in errors:
        print(e)
    sys.exit(1 if failed or errors else 0)
