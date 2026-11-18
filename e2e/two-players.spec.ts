import { type Page, expect, test } from '@playwright/test';

/** Walk one browser context from the title screen to "playing" in the given room. */
async function join(page: Page, room: string, name: string): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __lab3: { phase: string } }).__lab3.phase === 'press-to-start');
  await page.keyboard.press('Enter');
  await page.locator(`button[data-room="${room}"]`).waitFor();
  await page.locator('#lobby-name').fill(name);
  await page.locator(`button[data-room="${room}"]`).click();
  await page.waitForFunction(() => (window as unknown as { __lab3: { phase: string } }).__lab3.phase === 'playing');
}

const roster = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lab3: { net: { state: { roster: { name: string }[] } } } }).__lab3.net.state.roster.map((p) => p.name).sort());

test('two isolated browser contexts join one room, see each other, and chat', async ({ browser }) => {
  const ann = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await join(ann, 'alpha', 'Ann');
  await join(bob, 'alpha', 'Bob');

  await expect.poll(() => roster(ann)).toEqual(['Ann', 'Bob']);
  await expect.poll(() => roster(bob)).toEqual(['Ann', 'Bob']);

  await ann.locator('#chat-input').click();
  await ann.locator('#chat-input').fill('hello from Ann');
  await ann.keyboard.press('Enter');
  await expect(bob.locator('#chat-log')).toContainText('Ann: hello from Ann');

  // chat text is rendered as text, never as HTML
  await ann.locator('#chat-input').fill('<img src=x onerror=window.__pwned=1>');
  await ann.keyboard.press('Enter');
  await expect(bob.locator('#chat-log')).toContainText('<img src=x');
  expect(await bob.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  // leaving updates the other side
  await ann.context().close();
  await expect.poll(() => roster(bob)).toEqual(['Bob']);
  await bob.context().close();
});

test('two players in different rooms do not see each other', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await join(a, 'alpha', 'Solo1');
  await join(b, 'bravo', 'Solo2');
  await expect.poll(() => roster(a)).toEqual(['Solo1']);
  await expect.poll(() => roster(b)).toEqual(['Solo2']);
  await a.context().close();
  await b.context().close();
});
