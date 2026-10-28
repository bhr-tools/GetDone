"""End-to-end smoke test of the web app in Chromium (desktop and phone).

Run against a fresh instance (see tests/e2e/run.sh). Screenshots are written
to $OUT (default /out).
"""
import os
import re
import sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://getdone-e2e:8080")
OUT = os.environ.get("OUT", "/out")
PASSWORD = "correct horse"
errors = []


def watch(page):
    # The wrong-password check below answers 401 on purpose.
    page.on("console", lambda m: m.type in ("error", "warning") and "401" not in m.text
            and errors.append(f"console {m.type}: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"page error: {e}"))
    page.on("requestfailed", lambda r: errors.append(f"request failed: {r.url}"))


def shot(page, name):
    page.wait_for_timeout(250)
    page.screenshot(path=f"{OUT}/{name}.png")


def add_inline(page, text):
    page.locator(".composer-title").fill(text)
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)


def desktop(browser):
    ctx = browser.new_context(viewport={"width": 1280, "height": 820}, timezone_id="Europe/Paris")
    page = ctx.new_page()
    watch(page)
    page.goto(BASE)

    # First run: set the master password.
    page.get_by_label("Master password").fill(PASSWORD)
    page.get_by_label("Confirm password").fill(PASSWORD)
    shot(page, "d01-setup")
    page.get_by_role("button", name="Set password and continue").click()
    expect(page.locator("#view-title")).to_have_text("Inbox")
    shot(page, "d02-empty-inbox")

    # Inline composer with quick add tokens.
    page.locator(".add-task").first.click()
    page.locator(".composer-title").fill("Buy bread tomorrow 18h p1 @Bakery")
    shot(page, "d03-composer-tokens")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    add_inline(page, "Call the bank")
    add_inline(page, "Water plants every sunday")
    page.keyboard.press("Escape")
    expect(page.locator("#tasks .task-row")).to_have_count(3)
    first = page.locator("#tasks .task-row").first
    expect(first.locator(".task-title")).to_have_text("Buy bread")
    expect(first.locator(".badge.due")).to_contain_text("Tomorrow 18:00")
    expect(first.locator(".badge.location")).to_contain_text("Bakery")
    shot(page, "d04-inbox-tasks")

    # Keyboard: move the cursor, indent the third task under the second.
    page.locator("body").click(position={"x": 700, "y": 780})
    page.keyboard.press("G")
    page.keyboard.press("L")
    page.wait_for_timeout(400)
    expect(page.locator("#tasks .subtasks .task-row")).to_have_count(1)
    page.keyboard.press("H")
    page.wait_for_timeout(400)
    expect(page.locator("#tasks .subtasks .task-row")).to_have_count(0)

    # Priority with the keyboard, then complete and undo.
    page.keyboard.press("g")
    page.keyboard.press("g")
    page.keyboard.press("j")
    page.keyboard.press("2")
    page.wait_for_timeout(300)
    expect(page.locator("#tasks .task-row").nth(1)).to_have_class(re.compile(r"\bp2\b"))
    page.keyboard.press("d")
    expect(page.locator(".toast")).to_contain_text("Task completed")
    expect(page.locator("#tasks .task-row")).to_have_count(2)
    shot(page, "d05-completed-toast")
    page.keyboard.press("u")
    expect(page.locator("#tasks .task-row")).to_have_count(3)

    # Projects and sections.
    page.locator("#add-project").click()
    page.get_by_placeholder("e.g. Work, Home, Finances").fill("Work")
    page.get_by_role("button", name="Create", exact=True).click()
    expect(page.locator("#view-title")).to_have_text("Work")
    page.locator("#add-section").click()
    page.get_by_placeholder("e.g. In progress, Ideas").fill("Ideas")
    page.get_by_role("button", name="Add", exact=True).click()
    expect(page.locator(".group-title", has_text="Ideas")).to_be_visible()
    page.locator(".task-group").first.locator(".add-task").click()
    add_inline(page, "Prepare the quarterly review p2")
    add_inline(page, "Book meeting room")
    page.keyboard.press("Escape")
    shot(page, "d06-project")

    # Drag "Book meeting room" above the first task.
    rows = page.locator("#tasks .task-row")
    src = rows.nth(1).bounding_box()
    dst = rows.nth(0).bounding_box()
    page.mouse.move(src["x"] + 60, src["y"] + src["height"] / 2)
    page.mouse.down()
    page.mouse.move(src["x"] + 70, src["y"] + 10, steps=4)
    page.mouse.move(dst["x"] + 60, dst["y"] + 6, steps=8)
    shot(page, "d07-dragging")
    page.mouse.up()
    page.wait_for_timeout(500)
    expect(rows.nth(0).locator(".task-title")).to_have_text("Book meeting room")

    # Drag a task into the Ideas section.
    src = rows.nth(0).bounding_box()
    target = page.locator('.task-list[data-section-id]:not([data-section-id=""])').first
    page.mouse.move(src["x"] + 60, src["y"] + src["height"] / 2)
    page.mouse.down()
    page.mouse.move(src["x"] + 70, src["y"] + 20, steps=4)
    box = target.bounding_box()
    page.mouse.move(box["x"] + 40, box["y"] + 4, steps=8)
    page.mouse.up()
    page.wait_for_timeout(500)
    expect(page.locator('section[data-section-id] .task-title')).to_have_text("Book meeting room")

    # Task detail: open, change the due date with the picker, set priority.
    page.locator("#tasks .task-row", has_text="Prepare the quarterly review").click()
    expect(page.locator(".detail-title")).to_have_value("Prepare the quarterly review")
    shot(page, "d08-detail")
    page.locator(".field-button", has_text="No date").click()
    shot(page, "d09-datepicker")
    page.locator(".popover .menu-item", has_text="Tomorrow").click()
    page.wait_for_timeout(300)
    expect(page.locator(".field-button.due")).to_contain_text("Tomorrow")
    page.locator(".detail-title").click()
    page.locator(".detail-title").fill("Prepare the quarterly review 9am")
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    expect(page.locator(".field-button.due")).to_contain_text("09:00")
    page.locator(".detail-subtasks .input").fill("Collect numbers")
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    expect(page.locator(".detail-subtasks .task-row")).to_have_count(1)
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    expect(page.locator(".detail")).to_have_count(0)
    # The time survived opening and closing the panel.
    expect(page.locator("#tasks .task-row", has_text="Prepare").locator(".badge.due")).to_contain_text("09:00")

    # Upcoming.
    page.locator('.nav-item[data-nav="upcoming"]').click()
    expect(page.locator("#view-title")).to_have_text("Upcoming")
    shot(page, "d10-upcoming")

    # Search and help.
    page.keyboard.press("/")
    page.locator(".picker-input").fill("bread")
    page.wait_for_timeout(300)
    shot(page, "d11-search")
    page.keyboard.press("Enter")
    expect(page.locator(".detail-title")).to_have_value("Buy bread")
    page.keyboard.press("Escape")
    page.keyboard.press("?")
    shot(page, "d12-help")
    page.keyboard.press("Escape")

    # Lock and unlock.
    page.locator("#auth-menu").click()
    page.locator(".popover .menu-item", has_text="Lock").click()
    page.get_by_label("Password").fill("wrong")
    page.get_by_role("button", name="Unlock").click()
    expect(page.locator(".form-error")).to_contain_text("Incorrect password")
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Unlock").click()
    expect(page.locator(".auth")).to_have_count(0)
    ctx.storage_state(path=f"{OUT}/state.json")
    ctx.close()


def phone(browser):
    ctx = browser.new_context(storage_state=f"{OUT}/state.json", viewport={"width": 390, "height": 844},
                              device_scale_factor=2, is_mobile=True, has_touch=True, timezone_id="Europe/Paris")
    page = ctx.new_page()
    watch(page)
    page.goto(BASE)
    expect(page.locator("#tasks .task-row").first).to_be_visible()
    shot(page, "m01-inbox")
    page.locator("#menu-toggle").tap()
    page.wait_for_timeout(350)
    shot(page, "m02-sidebar")
    page.locator(".project-row", has_text="Work").tap()
    page.wait_for_timeout(400)
    shot(page, "m03-project")
    # iOS only opens the keyboard if the title gets the focus within the tap.
    focused = page.evaluate("""() => {
        document.getElementById('fab').click();
        return document.activeElement?.classList.contains('composer-title');
    }""")
    assert focused, "quick add title not focused synchronously by the FAB"
    page.wait_for_timeout(350)
    page.locator(".composer-title").fill("Phone task friday")
    shot(page, "m04-quick-add")
    page.locator(".chip").nth(1).tap()
    page.wait_for_timeout(300)
    shot(page, "m05-priority-sheet")
    page.locator(".popover .menu-item", has_text="Priority 1").tap()
    page.locator(".composer-submit").tap()
    page.wait_for_timeout(500)
    expect(page.locator("#tasks .task-row", has_text="Phone task")).to_have_count(1)
    page.locator("#tasks .task-row", has_text="Prepare").tap()
    page.wait_for_timeout(400)
    shot(page, "m06-detail-sheet")
    page.locator(".field-button", has_text="Repeat").tap()
    page.wait_for_timeout(300)
    shot(page, "m07-repeat-sheet")
    page.locator(".sheet-backdrop").tap(position={"x": 200, "y": 100})
    page.locator(".detail-header .icon-button").tap()
    page.wait_for_timeout(300)
    ctx.close()


def drag(page, source, target, dx=60, dy=None):
    """Drags source onto target (dy: offset from target's top; default middle)."""
    s = source.bounding_box()
    t = target.bounding_box()
    page.mouse.move(s["x"] + 60, s["y"] + s["height"] / 2)
    page.mouse.down()
    page.mouse.move(s["x"] + 70, s["y"] + s["height"] / 2 + 12, steps=4)
    page.mouse.move(t["x"] + dx, t["y"] + (t["height"] / 2 if dy is None else dy), steps=10)
    page.mouse.up()
    page.wait_for_timeout(500)


def workflows(browser):
    ctx = browser.new_context(storage_state=f"{OUT}/state.json", viewport={"width": 1280, "height": 820},
                              color_scheme="dark", timezone_id="Europe/Paris", accept_downloads=True)
    page = ctx.new_page()
    watch(page)
    page.goto(BASE)
    expect(page.locator("#tasks .task-row").first).to_be_visible()
    shot(page, "w01-dark-inbox")

    # Opening a task does not start editing; Enter does.
    page.locator("#tasks .task-row").first.click()
    expect(page.locator("#status-mode")).to_have_text("-- NORMAL --")
    expect(page.locator(".detail-place")).to_contain_text("Inbox")
    shot(page, "w02-dark-detail")
    page.keyboard.press("Enter")
    expect(page.locator(".detail-title")).to_be_focused()
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    expect(page.locator(".detail")).to_have_count(0)

    # Sorted by priority: reordering is refused with an explanation.
    page.locator("#sort-button").click()
    page.locator(".popover .menu-item", has_text="Priority").click()
    expect(page.locator("#sort-label")).to_have_text("Priority")
    first_title = page.locator("#tasks .task-row .task-title").first.inner_text()
    page.keyboard.press("J")
    expect(page.locator(".toast")).to_contain_text("switch to manual order")
    expect(page.locator("#tasks .task-row .task-title").first).to_have_text(first_title)
    page.reload()
    expect(page.locator("#sort-label")).to_have_text("Priority")  # persisted, inbox included
    page.locator("#sort-button").click()
    page.locator(".popover .menu-item", has_text="Manual order").click()

    # Select two tasks with Space and move them to Work with m.
    page.keyboard.press("g")
    page.keyboard.press("g")
    page.keyboard.press(" ")
    page.keyboard.press(" ")
    expect(page.locator("#status-mode")).to_have_text("-- VISUAL (2) --")
    page.keyboard.press("m")
    page.locator(".picker-input").fill("wor")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("2 tasks moved to Work")
    expect(page.locator("#tasks .task-row")).to_have_count(1)

    # A recurring task moves to its next occurrence when completed.
    page.locator("#tasks .task-row", has_text="Water plants").locator(".task-check").click()
    expect(page.locator(".toast")).to_contain_text("Next occurrence")
    expect(page.locator("#tasks .task-row", has_text="Water plants")).to_have_count(1)

    # Upcoming: drop a task on another day to reschedule it.
    page.locator('.nav-item[data-nav="upcoming"]').click()
    task = page.locator("#tasks .task-row", has_text="Buy bread")
    day = page.locator("section.task-group").nth(3)
    iso = day.get_attribute("data-date")
    drag(page, task, day.locator(".group-header"))
    expect(page.locator(f'section[data-date="{iso}"] .task-row', has_text="Buy bread")).to_have_count(1)
    expect(page.locator(f'section[data-date="{iso}"] .badge.due')).to_contain_text("18:00")  # time kept
    expect(page.locator(f'section[data-date="{iso}"] .badge.project')).to_have_text(re.compile("Inbox|Work"))

    # The date picker's time field changes the time and keeps the day.
    page.locator(f'section[data-date="{iso}"] .task-row', has_text="Buy bread").click()
    page.locator(".field-button.due").click()
    page.locator('.datepicker-time input[type="time"]').fill("07:45")
    page.keyboard.press("Enter")
    expect(page.locator(".field-button.due")).to_contain_text("07:45")
    page.keyboard.press("Escape")
    expect(page.locator(".detail")).to_have_count(0)
    expect(page.locator(f'section[data-date="{iso}"] .badge.due')).to_contain_text("07:45")

    # Overdue tasks can all be moved to today at once.
    page.keyboard.press("q")
    page.locator(".composer-title").fill("Pay rent 2020-01-15")
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    overdue = page.locator("section.task-group.overdue")
    expect(overdue.locator(".task-row", has_text="Pay rent")).to_have_count(1)
    shot(page, "w03-dark-upcoming")
    overdue.locator(".group-action").click()
    expect(overdue).to_have_count(0)
    expect(page.locator("section.task-group.today .task-row", has_text="Pay rent")).to_have_count(1)

    # Projects: create one and nest it under Work by dragging.
    page.locator("#add-project").click()
    page.get_by_placeholder("e.g. Work, Home, Finances").fill("Clients")
    page.get_by_role("button", name="Create", exact=True).click()
    expect(page.locator("#view-title")).to_have_text("Clients")
    work = page.locator(".project-row", has_text="Work")
    drag(page, page.locator(".project-row", has_text="Clients"), work, dx=work.bounding_box()["width"] - 20)
    expect(page.locator(".project-children .project-row", has_text="Clients")).to_have_count(1)
    shot(page, "w04-dark-nested-projects")

    # CSV: export Work, import it into Clients.
    page.locator(".project-row", has_text="Work").click()
    page.locator("#more-button").click()
    with page.expect_download() as download:
        page.locator(".popover .menu-item", has_text="Export").click()
    path = f"{OUT}/work.csv"
    download.value.save_as(path)
    assert "Prepare the quarterly review" in open(path, encoding="utf-8").read()
    page.locator(".project-row", has_text="Clients").click()
    page.locator("#more-button").click()
    with page.expect_file_chooser() as chooser:
        page.locator(".popover .menu-item", has_text="Import").click()
    chooser.value.set_files(path)
    expect(page.locator(".toast")).to_contain_text("Imported")
    expect(page.locator("#tasks .task-row", has_text="Prepare the quarterly review")).to_have_count(1)
    expect(page.locator(".group-title", has_text="Ideas")).to_be_visible()
    shot(page, "w05-dark-imported")
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    failed = False
    for scenario in (desktop, phone, workflows):
        try:
            scenario(browser)
            print(f"{scenario.__name__}: ok")
        except Exception as exc:  # report and keep going
            failed = True
            print(f"{scenario.__name__}: FAILED: {exc}")
    browser.close()
    for e in errors:
        print(e)
    sys.exit(1 if failed or errors else 0)
