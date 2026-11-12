"""End-to-end smoke test of the web app in Chromium (desktop and phone).

Run against a fresh instance (see tests/e2e/run.sh). Screenshots are written
to $OUT (default tests/e2e/out).
"""
import os
import re
import sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:18080")
OUT = os.environ.get("OUT", "tests/e2e/out")
PASSWORD = "correct horse"
errors = []


def tiny_png():
    """A valid 2x2 PNG, so the thumbnail really renders."""
    import struct, zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\x00" + b"\x31\x9c\x8f" * 2 for _ in range(2))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def watch(page):
    # The wrong-password check below answers 401 on purpose.
    page.on("console", lambda m: m.type in ("error", "warning") and "401" not in m.text
            and errors.append(f"console {m.type}: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"page error: {e}"))
    # A sync cut short by a reload or by closing the page is normal: the change
    # stays queued and is sent again.
    page.on("requestfailed", lambda r: "/api/sync" in r.url and "ERR_ABORTED" in (r.failure or "")
            or errors.append(f"request failed: {r.url}"))


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

    # Nest by pulling right in the gap under a task, then pull back left.
    prepare = page.locator("#tasks .task-row", has_text="Prepare the quarterly review")
    book = page.locator("#tasks .task-row", has_text="Book meeting room").bounding_box()
    pull(page, prepare, 40, book["y"] + book["height"] + 1, shot_name="d07b-nest-line")
    expect(page.locator("#tasks .subtasks .task-row", has_text="Prepare")).to_have_count(1)
    expect(page.locator(".drop-line")).to_be_hidden()
    nested = page.locator("#tasks .task-row", has_text="Prepare").bounding_box()
    pull(page, page.locator("#tasks .task-row", has_text="Prepare"), -40, nested["y"] + nested["height"] + 1)
    expect(page.locator("#tasks .subtasks .task-row")).to_have_count(0)
    expect(rows.nth(1).locator(".task-title")).to_have_text("Prepare the quarterly review")

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
    # Attachments: a photo shows as a thumbnail, a PDF as a chip.
    with page.expect_file_chooser() as fc:
        page.locator(".file-add").click()
    fc.value.set_files([
        {"name": "ticket.png", "mimeType": "image/png", "buffer": tiny_png()},
        {"name": "agenda.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4\n%%EOF\n"},
    ])
    expect(page.locator(".file-thumb img")).to_have_count(1)
    expect(page.locator(".file-chip")).to_contain_text("agenda.pdf")
    expect(page.locator(".file-thumb img")).to_have_js_property("naturalWidth", 2)
    shot(page, "d08b-attachments")
    page.locator(".file-chip").hover()
    page.locator(".file-item", has=page.locator(".file-chip")).locator(".file-remove").click()
    expect(page.locator(".file-chip")).to_have_count(0)
    page.locator(".toast-action", has_text="Undo").click()
    expect(page.locator(".file-chip")).to_have_count(1)
    page.locator(".detail-title").click()
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    expect(page.locator(".detail")).to_have_count(0)
    expect(page.locator("#tasks .task-row", has_text="Prepare").locator(".badge.files")).to_contain_text("2")
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
    # Select mode from the ⋯ menu: a tap selects instead of opening.
    page.locator("#more-button").tap()
    page.locator(".popover .menu-item", has_text="Select tasks").tap()
    expect(page.locator("#selection-bar .selection-count")).to_have_text("Tap tasks to select")
    page.locator("#tasks .task-row").nth(0).tap()
    page.locator("#tasks .task-row").nth(1).tap()
    expect(page.locator(".detail")).to_have_count(0)
    expect(page.locator("#selection-bar .selection-count")).to_have_text("2 selected")
    page.wait_for_timeout(250)
    shot(page, "m08-selection")
    page.locator("#selection-bar .selection-action", has_text="Date").tap()
    page.wait_for_timeout(300)
    shot(page, "m09-group-date")
    page.locator(".sheet-backdrop").tap(position={"x": 200, "y": 100})
    page.locator("#selection-bar .selection-close").tap()
    expect(page.locator("#selection-bar")).to_be_hidden()
    ctx.close()


def pull(page, source, dx, y, shot_name=None):
    """Drags source dx pixels sideways to the gap at y (Todoist-style nesting)."""
    s = source.bounding_box()
    x0, y0 = s["x"] + 60, s["y"] + s["height"] / 2
    page.mouse.move(x0, y0)
    page.mouse.down()
    page.mouse.move(x0 + 2, y0 + 10, steps=4)
    page.mouse.move(x0 + dx, y, steps=10)
    expect(page.locator(".drop-line")).to_be_visible()
    if shot_name:
        shot(page, shot_name)
    page.mouse.up()
    page.wait_for_timeout(500)


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

    # Group edits: Ctrl+click two tasks, set a location then a date, undo both.
    rows = page.locator("#tasks .task-row")
    rows.nth(0).click(modifiers=["Control"])
    rows.nth(1).click(modifiers=["Control"])
    expect(page.locator("#selection-bar .selection-count")).to_have_text("2 selected")
    expect(page.locator(".detail")).to_have_count(0)
    shot(page, "w05-selection-bar")
    page.keyboard.press("w")
    page.locator(".modal.dialog .input").fill("Gare de Lyon")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("Location set on 2 tasks")
    expect(page.locator("#tasks .badge.location", has_text="Gare de Lyon")).to_have_count(2)
    page.locator(".toast-action").click()
    expect(page.locator("#tasks .badge.location", has_text="Gare de Lyon")).to_have_count(0)
    page.locator("#selection-bar .selection-action", has_text="Date").click()
    page.locator(".popover .menu-item", has_text="Tomorrow").click()
    expect(page.locator(".toast")).to_contain_text("2 tasks due")
    expect(page.locator("#tasks .task-row.selected .badge.due", has_text="Tomorrow")).to_have_count(2)
    page.locator(".toast-action").click()
    expect(page.locator(".toast")).to_have_count(1)
    page.keyboard.press("Escape")
    expect(page.locator("#selection-bar")).to_be_hidden()
    # t on a single task: the picker stays narrow, not as wide as the row.
    page.keyboard.press("t")
    expect(page.locator(".popover .datepicker")).to_be_visible()
    assert page.locator(".popover").bounding_box()["width"] <= 342, "date picker stretched to the row"
    page.keyboard.press("Escape")
    expect(page.locator(".popover")).to_have_count(0)

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
    expect(page.locator(".project-row", has_text="Clients")).to_be_visible()
    expect(work).to_be_visible()
    w = work.bounding_box()
    pull(page, page.locator(".project-row", has_text="Clients"), 30, w["y"] + w["height"] + 1, shot_name="w04a-project-line")
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
