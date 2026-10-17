"""Record the README GIFs from the running console (`pnpm dev`, live backend through the tunnel).

    python3 docs/media/record.py [scene ...]      # scenes: pipeline review search issues report dispatch (default: all)

Frames are screenshots taken in a loop (sharp, unlike Playwright's video), timestamped, so waits for the
network can be cut. A caption strip names the sponsor service answering on screen; everything else is the
real console on real data. Writes docs/media/<scene>.gif (README) and <scene>.mp4 (full quality).
Needs: pip install playwright, Google Chrome (Playwright's Chromium can't play H.264), ffmpeg; gifsicle optional.

Run only when nobody needs the shared backend's GPU: the scenes read and search (cached VSS queries, one Ask),
but never press Run or Plan.
"""
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

URL = "http://localhost:3000"
OUT = Path(__file__).resolve().parent
W, H = 1440, 810                 # 16:9 viewport
GIF_W, GIF_FPS = 960, 8           # keeps footage-heavy GIFs under ~8 MB

SPONSORS = {                     # chip colours: each sponsor's brand colour
    "NVIDIA": ("#76B900", "#0b1400"), "CoreWeave": ("#2741E7", "#ffffff"), "VAST": ("#E4002B", "#ffffff"),
    "W&B": ("#FFBE00", "#1d1600"), "PIE GPS": ("#5b6475", "#ffffff"), "City of Toronto": ("#5b6475", "#ffffff"),
}

CAPTION_JS = """
window.__cap = (chips, text) => {
  let el = document.getElementById('__cap');
  if (!el) {
    el = document.createElement('div'); el.id = '__cap';
    el.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;' +
      'max-width:1180px;display:flex;align-items:center;gap:12px;padding:12px 18px;border-radius:12px;' +
      'background:rgba(14,17,24,.9);color:#fff;font:600 21px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.28);transition:opacity .25s;pointer-events:none;letter-spacing:-.005em';
    document.body.appendChild(el);
  }
  if (!text) { el.style.opacity = '0'; return; }
  el.innerHTML = '';
  for (const [label, bg, fg] of chips) {
    const c = document.createElement('span'); c.textContent = label;
    c.style.cssText = `flex:none;background:${bg};color:${fg};font:700 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;` +
      'padding:6px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:.04em';
    el.appendChild(c);
  }
  const t = document.createElement('span'); t.textContent = text; el.appendChild(t);
  el.style.opacity = '1';
};
"""


class Rec:
    """Screenshots in a loop while the scene waits, with wall-clock timestamps; `cut()` drops the time inside it.
    (Chrome's screencast crops headless Chrome's window, and Playwright's video is blurry.)"""

    def __init__(self, page: Page, name: str):
        self.page, self.name = page, name
        self.dir = Path(tempfile.mkdtemp(prefix=f"rw-{name}-"))
        self.frames: list[tuple[float, Path]] = []
        self.cuts: list[list[float]] = []
        self.on = False
        self.mx, self.my = W / 2, H / 2

    def shot(self):
        if not self.on:
            return
        t = time.time()
        path = self.dir / f"{len(self.frames):06d}.jpg"
        self.page.screenshot(path=str(path), type="jpeg", quality=90)
        self.frames.append((t, path))

    def start(self):
        self.page.evaluate("() => { window.__rec = 1 }")   # gone if the page reloads mid-scene
        self.on = True
        self.wait(0.3)

    def wait(self, s: float):
        end = time.time() + s
        while time.time() < end:
            self.shot()
            left = end - time.time()
            if left > 0.05:
                self.page.wait_for_timeout(min(40, int(left * 1000)))

    def cap(self, sponsors: list[str], text: str | None, hold: float = 0):
        self.page.evaluate("([c, t]) => window.__cap(c, t)",
                           [[[s, *SPONSORS[s]] for s in sponsors], text])
        if hold:
            self.wait(hold)

    def cut(self):
        rec = self

        class _Cut:
            def __enter__(self):
                rec.cuts.append([time.time(), 0.0])

            def __exit__(self, *exc):
                rec.wait(0.15)
                rec.cuts[-1][1] = time.time()
        return _Cut()

    def finish(self):
        self.wait(0.4)
        if not self.page.evaluate("() => window.__rec === 1"):
            raise RuntimeError(f"{self.name}: the page reloaded while recording (dev server rebuild?); run it again")
        frames = sorted(self.frames)
        keep = [(t, p) for t, p in frames if not any(a <= t < b for a, b in self.cuts)]
        lines = []
        for (t, p), nxt in zip(keep, keep[1:] + [(keep[-1][0] + 0.5, None)]):
            gap = nxt[0] - t
            if any(t < a <= nxt[0] for a, _ in self.cuts):   # the frame before a cut shows only briefly
                gap = min(gap, 0.1)
            lines += [f"file '{p}'", f"duration {max(gap, 0.02):.3f}"]
        lines.append(f"file '{keep[-1][1]}'")
        (self.dir / "list.txt").write_text("\n".join(lines))
        mp4, gif = OUT / f"{self.name}.mp4", OUT / f"{self.name}.gif"
        src = ["-f", "concat", "-safe", "0", "-i", str(self.dir / "list.txt")]
        subprocess.run(["ffmpeg", "-v", "error", "-y", *src, "-vf", f"fps=30,scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H},format=yuv420p", "-c:v", "libx264",
                        "-crf", "24", "-preset", "slow", "-movflags", "+faststart", str(mp4)], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", *src, "-vf",
                        f"fps={GIF_FPS},scale={GIF_W}:-1:flags=lanczos,split[a][b];"
                        "[a]palettegen=max_colors=160:stats_mode=diff[p];"
                        "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", str(gif)], check=True)
        if shutil.which("gifsicle"):                       # optional: about a quarter smaller, no visible change
            subprocess.run(["gifsicle", "-O3", "--lossy=80", "-b", str(gif)], check=True)
        shutil.rmtree(self.dir, ignore_errors=True)
        print(f"{self.name}: {gif.stat().st_size / 1e6:.1f} MB gif, {mp4.stat().st_size / 1e6:.1f} MB mp4")


def open_screen(page: Page, path: str, settle: float = 7):
    page.goto(URL + path, wait_until="domcontentloaded")
    page.wait_for_timeout(int(settle * 1000))
    page.evaluate("() => window.__cap([], null)")


def move_click(rec: Rec, locator, pause: float = 0.5):
    """Glide the pointer to the element before clicking, so the viewer can follow."""
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    for k in range(1, 9):     # glide, a frame per step, so the viewer can follow
        rec.page.mouse.move(rec.mx + (x - rec.mx) * k / 8, rec.my + (y - rec.my) * k / 8)
        rec.shot()
    rec.mx, rec.my = x, y
    rec.wait(pause)
    locator.click()


# --- scenes -----------------------------------------------------------------------------------------------

def review(rec: Rec):
    p = rec.page
    open_screen(p, "/review")
    move_click(rec, p.locator("button.vrow", has_text="set04/video_0002").filter(has_text="hazard").first, 0.2)
    p.wait_for_timeout(3000)
    # pre-roll off camera: the first hold on a finding is black until the video has decoded
    p.get_by_role("button", name="2×").click()
    p.get_by_role("button", name="Play", exact=True).click()
    p.wait_for_timeout(5000)
    rec.start()
    rec.cap(["VAST"], "16 Toronto fleet drives from the VAST DataEngine index, each summarised by Nemotron", 3)
    rec.cap(["NVIDIA", "CoreWeave"], "Cosmos3-Reason, served on CoreWeave GPUs, finds and boxes every defect, 5 s at a time", 4.5)
    rec.cap(["PIE GPS", "VAST"], "Each finding is pinned from the drive's 1 Hz GPS; keyframes are stored in VAST S3", 4.5)
    card = p.locator(".issue").last                         # the selected finding, under the map
    card.hover()
    for _ in range(5):
        p.mouse.wheel(0, 90)
        rec.wait(0.1)
    rec.cap(["NVIDIA"], "Cosmos3-Reason re-grades each finding from its boxed close-up and says why", 4.5)
    rec.cap([], None, 0.6)


def search(rec: Rec):
    p = rec.page
    open_screen(p, "/review")
    rec.start()
    box = p.get_by_placeholder("Search footage, e.g. traffic cones")
    move_click(rec, box, 0.2)
    rec.cap(["VAST"], "Search 1.5 hours of footage in plain language, over the VAST VSS index")
    box.press_sequentially("pothole", delay=110)
    rec.wait(0.4)
    with rec.cut():
        box.press("Enter")
        p.locator(".topic-answer:not(.muted)").first.wait_for(timeout=60_000)
    rec.wait(1.5)
    rec.cap(["NVIDIA", "W&B"], "Nemotron on W&B Inference answers from the matches, and says which are already logged", 5.5)
    move_click(rec, p.locator("button.vrow").first, 0.3)
    rec.wait(1.2)
    rec.cap(["VAST"], "The matches become a lane on the drive's timeline; a logged match opens its issue", 4)
    move_click(rec, p.get_by_role("radio", name="Chat").or_(p.get_by_role("button", name="Chat")).first, 0.3)
    rec.wait(0.8)
    rec.cap(["NVIDIA", "W&B"], "Ask the drive a question in plain language")
    ask = p.get_by_placeholder("Ask about this drive…")
    move_click(rec, ask, 0.2)
    ask.press_sequentially("Any hazards near 03:48?", delay=70)    # asked before, so VSS answers it from the cache
    rec.wait(0.3)
    with rec.cut():
        ask.press("Enter")
        p.locator(".msg:not(.msg-user)").last.wait_for(timeout=60_000)
        p.wait_for_function("() => !document.querySelector('.chat [role=status]')", timeout=60_000)
    # caption from the reply's own source line, so it never claims evidence the answer didn't use
    meta = p.locator(".chat .msg:not(.msg-user)").last.inner_text()
    vss = re.search(r"from (\d+) VSS caption", meta)
    if "VSS caption" in meta and not vss:
        rec.cap(["VAST"], "Nemotron was unavailable, so the answer quotes the nearest VSS caption, labelled as such")
    elif vss and int(vss.group(1)):
        rec.cap(["NVIDIA", "W&B", "VAST"], f"Nemotron answers from {vss.group(1)} VSS captions of this drive and its logged findings")
    else:
        rec.cap(["NVIDIA", "W&B"], "Nemotron answers from the findings logged on this drive")
    rec.wait(3.5)
    evidence = p.get_by_text("VSS evidence").last
    if evidence.count():
        move_click(rec, evidence, 0.2)                    # the VSS captions the answer was built from
        rec.wait(3)
    chip = p.locator(".tchip").first
    if chip.count():
        rec.cap(["NVIDIA"], "Times in the answer are links: one click seeks the player to that finding", 1)
        move_click(rec, chip, 0.3)
        rec.wait(3.5)
    rec.cap([], None, 0.6)


def issues(rec: Rec):
    p = rec.page
    open_screen(p, "/issues")
    rec.start()
    rec.cap(["NVIDIA", "VAST"], "319 open issues across the city, after Cosmos rejected 136 non-defects; records in VastDB", 3)
    move_click(rec, p.get_by_role("radio", name="S5+").or_(p.get_by_role("button", name="S5+")).first, 0.3)
    rec.wait(1)
    move_click(rec, p.locator("tbody tr[tabindex]").first, 0.3)
    rec.wait(1.5)
    rec.cap(["NVIDIA", "CoreWeave"], "Cosmos3-Reason drew the box and graded the severity, with its reason", 4.5)
    side = p.locator("aside.split-side")
    side.hover()
    for _ in range(4):
        p.mouse.wheel(0, 90)
        rec.wait(0.12)
    rec.cap(["NVIDIA", "W&B"], "Nemotron Lightning on W&B Inference wrote the work order: repair, crew, minutes, kit", 4)
    with rec.cut():
        p.get_by_text("VastDB vector search").first.wait_for(timeout=30_000)
    for _ in range(6):
        p.mouse.wheel(0, 120)
        rec.wait(0.12)
    rec.cap(["NVIDIA", "VAST"], "Similar issues city-wide: Cosmos-Embed1 vectors, cosine search inside VastDB", 5)
    rec.cap([], None, 0.6)


def report(rec: Rec):
    p = rec.page
    open_screen(p, "/report")
    rec.start()
    rec.cap(["NVIDIA", "W&B"], "Nemotron 3 Ultra on W&B Inference writes tomorrow's situation report", 4.5)
    p.locator("main").first.hover()
    rec.cap(["NVIDIA"], "Every safety hazard, worst first, each with its Cosmos-graded reason and its frame")
    for _ in range(9):
        p.mouse.wheel(0, 110)
        rec.wait(0.14)
    rec.wait(2.5)
    p.get_by_role("region", name="Data provenance").scroll_into_view_if_needed()
    rec.wait(0.6)
    rec.cap(["NVIDIA", "W&B", "VAST"], "Figures come from code; the report says which model answered every step", 5)
    rec.cap([], None, 0.6)


def dispatch(rec: Rec):
    p = rec.page
    open_screen(p, "/dispatch", settle=9)
    panel = p.locator("#dispatch-panel")                     # the plan panel, not the top bar's filters
    tab = lambda name: panel.get_by_role("radio", name=name).or_(panel.get_by_role("button", name=name)).first
    meta = panel.inner_text().upper()
    rec.start()
    solver = "cuOpt" if "CUOPT" in meta else "The fallback router"   # never caption a fallback as cuOpt
    rec.cap(["NVIDIA"] if solver == "cuOpt" else [],
            f"{solver} routes every crew as a round trip from its own yard, on real street times", 4.5)
    if "TRIAGE NEMOTRON" in meta:
        move_click(rec, tab("Triage"), 0.3)
        rec.wait(0.8)
        rec.cap(["NVIDIA", "W&B"], "Nemotron 3 Ultra triaged each job into today, later or defer, with a reason", 4.5)
    # "New plan" only opens the planning view (nothing is re-planned): it shows the crew recommendation
    move_click(rec, panel.get_by_role("button", name="New plan"), 0.3)
    rec.wait(1)
    card = panel.inner_text().lower()                     # labels render in CSS uppercase
    if "nemotron proposed" in card and "cuopt solved" in card:
        picked = "and picked one" if "nemotron picked" in card else "and a rule picked one"
        rec.cap(["NVIDIA", "W&B"], f"Nemotron 3 Ultra proposed crew scenarios {picked}; cuOpt solved each one to score it", 5.5)
    move_click(rec, panel.get_by_role("button", name="Keep current plan"), 0.3)
    rec.wait(0.6)
    move_click(rec, tab("Roads"), 0.3)
    rec.wait(0.8)
    rec.cap(["City of Toronto", "NVIDIA"], "Road alerts: the City's live closures plus work zones Cosmos saw; routes go around them", 4)
    move_click(rec, p.get_by_text("5×", exact=True).first, 0.2)
    move_click(rec, p.get_by_role("button", name="Play shift"), 0.2)
    rec.cap(["NVIDIA"] if solver == "cuOpt" else [], "Play the shift: every crew, every stop, from 08:00 back to the yard", 6.5)
    rec.cap([], None, 0.6)


def pipeline(rec: Rec):
    """The animated overview (pipeline.html): stages, real numbers and Weave trace counts."""
    p = rec.page
    p.goto((OUT / "pipeline.html").as_uri(), wait_until="networkidle")
    p.evaluate("() => document.fonts.ready")
    rec.start()
    p.evaluate("() => window.__play()")
    rec.wait(0.4 + 6 * 2.1 + 3.5)


SCENES = {"pipeline": pipeline, "review": review, "search": search, "issues": issues, "report": report, "dispatch": dispatch}


def main(names: list[str]):
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", args=[f"--window-size={W},{H + 160}"])   # Google Chrome: plays the H.264 footage
        for name in names:
            ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
            ctx.add_init_script(CAPTION_JS)
            page = ctx.new_page()
            rec = Rec(page, name)
            SCENES[name](rec)
            rec.finish()
            ctx.close()
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:] or list(SCENES))
