from selenium import webdriver
from selenium.webdriver.firefox.options import Options
o = Options(); o.add_argument('-headless')
d = webdriver.Firefox(options=o)
d.get('about:blank')
r = d.execute_async_script('''
const done = arguments[0], out = [];
requestAnimationFrame(() => { out.push("raf"); Promise.resolve().then(() => out.push("then-in-raf")); });
requestAnimationFrame(() => out.push("raf2"));
setTimeout(() => out.push("timeout"), 0);
Promise.resolve().then(() => out.push("then"));
out.push("sync");
setTimeout(() => done(out), 200);
''')
print('P5 (rAF) ->', ' '.join(r))
d.quit()
