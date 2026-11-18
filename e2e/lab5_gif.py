"""Lab 5 GIF recorder (helpers shared with lab5.py). Original docstring: Lab 5 end-to-end: real server (NetSim enabled) + two real Firefox windows over a simulated 100+-30 ms / 2% loss link.
Run:  /tmp/e2e-venv/bin/python e2e/lab5.py   (after `npm run build`)
Screenshots are real window captures (Selenium), saved to docs/lab5-shots/."""
import json, os, subprocess, tempfile, time, urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.firefox.options import Options

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3112
BASE = f'http://127.0.0.1:{PORT}/'
LOGS = tempfile.mkdtemp(prefix='dogfight-e2e5-logs-')
SHOTS = os.path.join(ROOT, 'docs/lab5-shots')
NET = 'lag=100&jitter=30&drop=2'
results = []

def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS' if cond else 'FAIL'), name, extra, flush=True)

def start_server():
    env = dict(os.environ, PORT=str(PORT), HOST='127.0.0.1', STATIC_DIR=os.path.join(ROOT, 'client/dist'), LOG_DIR=LOGS, ENABLE_NETSIM='1')
    p = subprocess.Popen(['node', os.path.join(ROOT, 'server/src/index.js')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(50):
        try: urllib.request.urlopen(BASE + 'health', timeout=0.5); return p
        except Exception: time.sleep(0.1)
    raise RuntimeError('server did not start')

def driver():
    o = Options(); o.add_argument('-headless'); o.set_preference('media.volume_scale', '0.0'); o.set_preference('media.autoplay.default', 5)
    d = webdriver.Firefox(options=o); d.set_window_size(1100, 1100); return d

def js(d, s): return d.execute_script(s)
def wait(d, pred, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if pred(): return True
        except Exception: pass
        time.sleep(0.1)
    return False

def enter_room(d, name, query, room='alpha'):
    d.get(BASE + '?' + query)
    assert wait(d, lambda: js(d, 'return window.__lab3.phase') == 'press-to-start')
    ActionChains(d).send_keys(Keys.ENTER).perform()
    assert wait(d, lambda: js(d, 'return window.__lab3.phase') == 'lobby')
    assert wait(d, lambda: len(d.find_elements(By.CSS_SELECTOR, f'button[data-room="{room}"]')) == 1)
    n = d.find_element(By.ID, 'lobby-name'); n.clear(); n.send_keys(name)
    d.find_element(By.CSS_SELECTOR, f'button[data-room="{room}"]').click()
    assert wait(d, lambda: js(d, 'return window.__lab3.phase') == 'playing')
    assert wait(d, lambda: js(d, 'return !!(window.__lab3.client && window.__lab3.client.latest)'))

def metrics(d): return js(d, 'const m = window.__lab3.client.metrics(); return {rtt: m.rttMs, in: m.bytesInPerSec, out: m.bytesOutPerSec, pending: m.pending, corr: m.correction, max: m.correctionMax, snaps: m.snapshotsPerSec, codec: window.__lab3.client.codec.name}')
def shot(d, name): d.save_screenshot(os.path.join(SHOTS, name))
def me(d): return js(d, 'const s = window.__lab3.client.localView; return s ? {x: s.pos.x, y: s.pos.y, vx: s.vel.x, vy: s.vel.y} : null')


import io, random
from PIL import Image
FRAMES, INTERVAL = 70, 0.3   # ~21 s of play at ~3 fps: real captures, not smooth video
server = start_server()
d1 = d2 = None
try:
    d1, d2 = driver(), driver()
    enter_room(d1, 'Ann', NET); enter_room(d2, 'Bob', NET)
    rng = random.Random(5)
    held = {d1: set(), d2: set()}
    def hold(d, keys):
        for k in held[d] - keys: ActionChains(d).key_up(k).perform()
        for k in keys - held[d]: ActionChains(d).key_down(k).perform()
        held[d] = set(keys)
    frames = []
    for i in range(FRAMES):
        if i % 6 == 0:
            for d in (d1, d2):
                hold(d, {k for k in ('w', 'a', 'd', Keys.SPACE) if rng.random() < {'w': .7, 'a': .3, 'd': .3, Keys.SPACE: .4}[k]})
        t0 = time.time()
        a = Image.open(io.BytesIO(d1.get_screenshot_as_png())).convert('RGB')
        b = Image.open(io.BytesIO(d2.get_screenshot_as_png())).convert('RGB')
        w, h = a.size
        both = Image.new('RGB', (w * 2, h)); both.paste(a, (0, 0)); both.paste(b, (w, 0))
        frames.append(both.resize((both.width // 2, both.height // 2), Image.LANCZOS))
        time.sleep(max(0, INTERVAL - (time.time() - t0)))
    out = os.path.join(SHOTS, 'two-players.gif')
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=int(INTERVAL * 1000), loop=0, optimize=True)
    print('wrote', out, os.path.getsize(out) // 1024, 'KB')
finally:
    for d in (d1, d2):
        if d: d.quit()
    server.terminate()
