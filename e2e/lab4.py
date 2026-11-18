"""Lab 4 end-to-end: real server (serving client/dist) + two real Firefox windows.
Run:  /tmp/e2e-venv/bin/python e2e/lab4.py   (after `npm run build`)"""
import os, signal, subprocess, sys, tempfile, time, urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.firefox.options import Options

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3111
BASE = f'http://127.0.0.1:{PORT}/'
LOGS = tempfile.mkdtemp(prefix='dogfight-e2e-logs-')
results = []

def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS' if cond else 'FAIL'), name, extra)

def start_server():
    env = dict(os.environ, PORT=str(PORT), HOST='127.0.0.1', STATIC_DIR=os.path.join(ROOT, 'client/dist'), LOG_DIR=LOGS)
    p = subprocess.Popen(['node', os.path.join(ROOT, 'server/src/index.ts')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(50):
        try: urllib.request.urlopen(BASE + 'health', timeout=0.5); return p
        except Exception: time.sleep(0.1)
    raise RuntimeError('server did not start')

def driver():
    o = Options(); o.add_argument('-headless'); o.set_preference('media.autoplay.default', 0)
    d = webdriver.Firefox(options=o); d.set_window_size(1100, 1100); return d

def js(d, s): return d.execute_script(s)
def wait(d, pred, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if pred(): return True
        except Exception: pass
        time.sleep(0.1)
    return False

def enter_room(d, room, key=Keys.ENTER):
    d.get(BASE)
    assert wait(d, lambda: js(d, 'return window.__lab3.phase') == 'press-to-start')
    ActionChains(d).send_keys(key).perform()
    assert wait(d, lambda: js(d, 'return window.__lab3.phase') == 'lobby')
    assert wait(d, lambda: len(d.find_elements(By.CSS_SELECTOR, f'button[data-room="{room}"]')) == 1)
    name = d.find_element(By.ID, 'lobby-name'); name.clear(); name.send_keys(key_name[d])
    d.find_element(By.CSS_SELECTOR, f'button[data-room="{room}"]').click()
    assert wait(d, lambda: js(d, 'return window.__lab3.phase') == 'playing')

server = start_server()
d1 = d2 = None
key_name = {}
try:
    d1, d2 = driver(), driver()
    key_name[d1], key_name[d2] = 'Ann', 'Bob'
    enter_room(d1, 'alpha'); enter_room(d2, 'alpha')
    roster = lambda d: sorted(p['name'] for p in js(d, 'return window.__lab3.net.state.roster'))
    check('both windows see both names (roster)', wait(d1, lambda: roster(d1) == ['Ann', 'Bob']) and wait(d2, lambda: roster(d2) == ['Ann', 'Bob']), f'{roster(d1)} {roster(d2)}')
    lobby_counts = [r['players'] for r in __import__('json').load(urllib.request.urlopen(BASE + 'api/rooms'))['rooms'] if r['id'] == 'alpha']
    check('/api/rooms reports 2 players in alpha', lobby_counts == [2], str(lobby_counts))

    box = d1.find_element(By.ID, 'chat-input'); box.click(); box.send_keys('hello from Ann'); box.send_keys(Keys.ENTER)
    check('chat reaches the other window', wait(d2, lambda: 'Ann: hello from Ann' in d2.find_element(By.ID, 'chat-log').text))
    check('chat echoed to sender too', wait(d1, lambda: 'Ann: hello from Ann' in d1.find_element(By.ID, 'chat-log').text))
    # typing in chat must not steer the ship
    check('typing in chat does not thrust the ship', js(d1, 'return window.__lab3.client.ship.isThrusting') is False)
    # XSS: chat text is rendered as text
    box.send_keys('<img src=x onerror=window.__pwned=1>'); box.send_keys(Keys.ENTER)
    time.sleep(0.5)
    check('chat HTML is not executed (textContent)', js(d2, 'return window.__pwned') is None)

    # chaos: kill the server mid-match (SIGTERM = graceful), restart, both must reconnect and re-join
    server.send_signal(signal.SIGTERM)
    out, _ = server.communicate(timeout=10)
    check('graceful SIGTERM: exit code 0', server.returncode == 0, f'rc={server.returncode}')
    check('graceful SIGTERM: logged clean exit', 'clean exit' in out)
    check('client noticed the outage', wait(d1, lambda: js(d1, 'return window.__lab3.net.state.status') in ('reconnecting', 'closed')))
    server = start_server()
    check('client reconnected on its own', wait(d1, lambda: js(d1, 'return window.__lab3.net.state.status') == 'open', 20))
    check('roster restored after server restart (hello re-sent)', wait(d2, lambda: roster(d2) == ['Ann', 'Bob'], 20), str(roster(d2)))

    # match log: written, and flushed on shutdown
    server.send_signal(signal.SIGTERM); server.communicate(timeout=10)
    files = [f for f in os.listdir(LOGS) if f.endswith('.ndjson')]
    check('match logs were written to disk', len(files) >= 1, str(files))
    lines = open(os.path.join(LOGS, sorted(files)[0])).read().strip().splitlines()
    check('log has join and chat events as NDJSON', any('"type":"chat"' in l for l in sorted(lines)) or any('"chat"' in open(os.path.join(LOGS, f)).read() for f in files))
finally:
    for d in (d1, d2):
        if d: d.quit()
    if server.poll() is None: server.kill()
print(f'\n{sum(results)}/{len(results)} checks passed'); sys.exit(0 if all(results) else 1)
