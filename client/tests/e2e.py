"""End-to-end test in real headless Firefox. Run: python tests/e2e.py  (dev server on :5173)."""
import sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.firefox.options import Options

BASE = 'http://localhost:5173/'
results = []

def check(name, cond, extra=''):
    results.append(cond)
    print(('PASS' if cond else 'FAIL'), name, extra)

def driver():
    o = Options(); o.add_argument('-headless')
    o.set_preference('media.autoplay.default', 0)
    d = webdriver.Firefox(options=o); d.set_window_size(1100, 1100); return d

def wait_phase(d, phases, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        p = d.execute_script('return window.__lab3 && window.__lab3.phase')
        if p in phases: return p
        time.sleep(0.1)
    return d.execute_script('return window.__lab3 && window.__lab3.phase')

def press(d, key):
    ActionChains(d).send_keys(key).perform()

# 1. Happy path
d = driver()
try:
    d.get(BASE)
    check('loads to press-to-start', wait_phase(d, ['press-to-start']) == 'press-to-start')
    check('no failed assets', d.execute_script('return window.__lab3.failures.length') == 0,
          str(d.execute_script('return window.__lab3.failures')))
    check('progress reached 1', d.execute_script('return window.__lab3.progress') == 1)
    press(d, Keys.ENTER)
    check('lobby shown after gesture', wait_phase(d, ['lobby']) == 'lobby')
    check('AudioContext running after gesture', d.execute_script('return window.__lab3.audioState()') == 'running',
          d.execute_script('return window.__lab3.audioState()'))
    time.sleep(0.6)
    rooms = d.find_elements(By.CSS_SELECTOR, '#lobby-rooms li')
    check('lobby lists 3 rooms', len(rooms) == 3, str(len(rooms)))
    d.find_element(By.CSS_SELECTOR, 'button[data-room="alpha"]').click()
    check('joined -> playing', wait_phase(d, ['playing']) == 'playing')
    time.sleep(0.5)
    n_asteroids = d.execute_script('let n=0; for (const e of window.__lab3.world) if (e.kind===3) n++; return n')
    check('room config applied (alpha = 3 asteroids)', n_asteroids == 3, str(n_asteroids))
    fired = d.execute_script('''window.__fired = 0; window.__lab3.world.bus.addEventListener("fired", () => window.__fired++); return 0''')
    ActionChains(d).key_down(Keys.SPACE).pause(1.0).key_up(Keys.SPACE).perform()
    check('holding Space fires bullets (event bus "fired")', d.execute_script('return window.__fired') >= 3,
          str(d.execute_script('return window.__fired')))
    # sim has no audio/hud import
    d.save_screenshot('/tmp/lab3-playing.png')
    reqs0 = d.execute_script('return performance.getEntriesByType("resource").filter(r=>r.name.includes("rooms.json")).length')
    time.sleep(6)
    reqs1 = d.execute_script('return performance.getEntriesByType("resource").filter(r=>r.name.includes("rooms.json")).length')
    check('no lobby polling after leaving lobby', reqs0 == reqs1, f'{reqs0} -> {reqs1}')
    # kill ship and verify respawn in the real game
    d.execute_script('''const w=window.__lab3.world, s=window.__lab3.ship; s.invulnTimer=0;
        const {constructor: A} = [...w].find(e=>e.kind===3); w.spawn(new A({pos: s.pos.clone(), tier:1}));''')
    d.execute_script('window.__lab3.ship.takeDamage(0)')
    for _ in range(8):
        d.execute_script('''const w=window.__lab3.world, s=window.__lab3.ship; s.invulnTimer=0;
            const A=[...w].find(e=>e.kind===3).constructor; w.spawn(new A({pos: s.pos.clone(), tier:1}));''')
        time.sleep(0.4)
        if not d.execute_script('return window.__lab3.ship.alive'): break
    check('ship destroyed by asteroids', not d.execute_script('return window.__lab3.ship.alive'))
    time.sleep(2.6)
    check('ship respawned after ~2s', d.execute_script('return window.__lab3.ship.alive') is True)
finally:
    d.quit()

# 2. Optional sprite 404 -> still starts with fallback
d = driver()
try:
    d.get(BASE + '?chaos=sprite404')
    check('sprite404: game still reaches start screen', wait_phase(d, ['press-to-start']) == 'press-to-start')
    f = d.execute_script('return window.__lab3.failures')
    check('sprite404: failure recorded', len(f) == 1 and f[0]['name'] == 'sprites', str(f))
    press(d, Keys.ENTER); wait_phase(d, ['lobby']); time.sleep(0.6)
    d.find_element(By.CSS_SELECTOR, 'button[data-room="bravo"]').click()
    check('sprite404: playable with vector fallback', wait_phase(d, ['playing']) == 'playing')
    time.sleep(0.5)
    d.save_screenshot('/tmp/lab3-fallback.png')
finally:
    d.quit()

# 3. Corrupt required JSON -> load-error + Retry button
d = driver()
try:
    d.get(BASE + '?chaos=corrupt')
    check('corrupt json: load-error phase', wait_phase(d, ['load-error']) == 'load-error')
    btn = d.find_elements(By.ID, 'retry')
    check('corrupt json: Retry button visible', len(btn) == 1 and btn[0].is_displayed())
    check('corrupt json: error is SyntaxError', 'SyntaxError' in d.execute_script('return window.__lab3.error'),
          d.execute_script('return window.__lab3.error'))
    d.save_screenshot('/tmp/lab3-error.png')
finally:
    d.quit()

# 4. Missing required JSON (404) -> not retried on 4xx, error shown
d = driver()
try:
    d.get(BASE + '?chaos=json404')
    t0 = time.time()
    check('json404: load-error phase', wait_phase(d, ['load-error']) == 'load-error')
    check('json404: fast (4xx not retried)', time.time() - t0 < 3, f'{time.time()-t0:.1f}s')
    # Vite dev server answers unknown paths with index.html (200), so the app sees a SyntaxError here;
    # a real static server would give HttpError. Either way: required failure -> error screen, no retry storm.
    err = d.execute_script('return window.__lab3.error')
    check('json404: error reported', 'HttpError' in err or 'SyntaxError' in err, err)
finally:
    d.quit()

# 5. Slow loading -> real intermediate progress
d = driver()
try:
    d.get(BASE + '?chaos=slow')
    seen = set()
    end = time.time() + 12
    while time.time() < end:
        seen.add(round(d.execute_script('return window.__lab3 ? window.__lab3.progress : 0'), 2))
        if d.execute_script('return window.__lab3.phase') == 'press-to-start': break
        time.sleep(0.05)
    check('slow: loading screen visible then completes', wait_phase(d, ['press-to-start']) == 'press-to-start')
    check('slow: intermediate progress observed', any(0 < p < 1 for p in seen), str(sorted(seen)))
finally:
    d.quit()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
