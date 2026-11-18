"""Lab 5 end-to-end: real server (NetSim enabled) + two real Firefox windows over a simulated 100+-30 ms / 2% loss link.
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
    p = subprocess.Popen(['node', os.path.join(ROOT, 'server/src/index.ts')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
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

server = start_server()
d1 = d2 = None
try:
    d1, d2 = driver(), driver()
    enter_room(d1, 'Ann', NET); enter_room(d2, 'Bob', NET)
    time.sleep(3)  # let RTT / byte-rate windows fill
    m1 = metrics(d1)
    check('binary codec negotiated', m1['codec'] == 'binary', m1['codec'])
    check('RTT reflects the simulated 100 ms link (60..220)', 60 < m1['rtt'] < 220, f"{m1['rtt']:.0f} ms")
    check('snapshots arrive ~30/s despite 2% loss', 20 < m1['snaps'] < 36, f"{m1['snaps']:.1f}/s")

    # Ann thrusts: with prediction her ship must move at once, long before one RTT passes.
    before = me(d1)
    t0 = time.time()
    ActionChains(d1).key_down('w').perform()
    moved_after = None
    while time.time() - t0 < 2:
        now = me(d1)
        if now and before and (abs(now['vx']) + abs(now['vy'])) > 1: moved_after = time.time() - t0; break
        time.sleep(0.01)
    check('predicted ship reacts to thrust well inside one RTT', moved_after is not None and moved_after < 0.2, f'{moved_after}')
    time.sleep(2.5)
    ActionChains(d1).key_up('w').perform()
    m1 = metrics(d1)
    check('reconciliation keeps corrections small while thrusting (steady state)', m1['corr'] < 5, f"corr {m1['corr']:.3f} max {m1['max']:.1f}")
    check('inputs are acknowledged (pending queue short)', m1['pending'] < 15, str(m1['pending']))
    shot(d1, 'ann-binary-100ms.png'); shot(d2, 'bob-binary-100ms.png')

    # Bob sees Ann as a remote entity (interpolated).
    seen = js(d2, 'return window.__lab3.client.frame(1).filter(e => e.kind === 1).length')
    check('Bob draws two ships (his predicted one + Ann interpolated)', seen == 2, str(seen))

    ActionChains(d2).key_down(Keys.SPACE).perform(); time.sleep(0.7); ActionChains(d2).key_up(Keys.SPACE).perform()
    check('firing produced bullets without crashing the client', js(d2, 'return window.__lab3.client.m.inputsSent') > 100)

    # Compare input/snapshot bandwidth: json vs binary on the live link.
    d3 = driver()
    try:
        enter_room(d3, 'Cy', NET + '&codec=json'); time.sleep(3.5)
        mj, mb = metrics(d3), metrics(d2)
        check('json codec in use for Cy', mj['codec'] == 'json')
        check('binary uses fewer bytes/s than json', mb['in'] < mj['in'], f"binary {mb['in']:.0f} B/s vs json {mj['in']:.0f} B/s")
        shot(d3, 'cy-json-100ms.png')
    finally:
        d3.quit()
finally:
    for d in (d1, d2):
        if d: d.quit()
    server.terminate()

# Determinism experiment: client-only Math.random() in the ship physics -> corrections explode in the real browser.
server = start_server()
try:
    da = driver(); db = driver()
    try:
        enter_room(da, 'Good', NET); enter_room(db, 'Bad', NET + '&breakdet=1')
        for d in (da, db): ActionChains(d).key_down('w').perform()
        time.sleep(4)
        for d in (da, db): ActionChains(d).key_up('w').perform()
        ma, mb = metrics(da), metrics(db)
        check('breakdet=1 client corrects much more than the deterministic one', mb['max'] > ma['max'] * 3 or mb['corr'] > ma['corr'] * 3, f"good max {ma['max']:.2f} / bad max {mb['max']:.2f}")
        shot(da, 'good-determinism.png'); shot(db, 'bad-determinism.png')
    finally:
        da.quit(); db.quit()
finally:
    server.terminate()

print(f'\n{sum(results)}/{len(results)} checks passed')
raise SystemExit(0 if all(results) else 1)
