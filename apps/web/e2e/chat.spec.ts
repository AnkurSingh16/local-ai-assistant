import type { Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

// The API runs with PROVIDERS=mock: a fixed answer, and a moderator that flags
// the markers MOCK_FLAG and MOCK_FLAG_SELF_HARM.
const mockAnswer = 'This is a mock answer from the test chat provider.';

/** Fails any test whose page logs an error, including CSP violations. */
const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto('/');
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

async function ask(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('streams an answer through the real API', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Local AI Assistant' })).toBeVisible();
  await ask(page, 'Hello there');
  await expect(page.getByLabel('You')).toHaveText('Hello there');
  await expect(page.getByLabel('Assistant')).toContainText(mockAnswer);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
});

test('refuses flagged input with the fixed message', async ({ page }) => {
  await ask(page, 'MOCK_FLAG please');
  await expect(page.getByRole('note')).toHaveText(
    "I can't help with that. I'm happy to help with something else.",
  );
  await expect(page.getByLabel('Assistant')).not.toContainText(mockAnswer);
});

test('answers self-harm input with crisis resources', async ({ page }) => {
  await ask(page, 'MOCK_FLAG_SELF_HARM');
  await expect(page.getByRole('note')).toContainText('988');
  await expect(page.getByRole('note')).toContainText('findahelpline.com');
});

test('keeps a conversation of several turns', async ({ page }) => {
  await ask(page, 'First');
  await expect(page.getByLabel('Assistant').first()).toContainText(mockAnswer);
  await ask(page, 'Second');
  await expect(page.getByLabel('You')).toHaveText(['First', 'Second']);
  await expect(page.getByLabel('Assistant').nth(1)).toContainText(mockAnswer);
});

test('starts a session, shows the memory view and deletes everything', async ({ page }) => {
  await ask(page, 'Hello there');
  await expect(page.getByLabel('Assistant')).toContainText(mockAnswer);
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'lai_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
  await page.getByRole('button', { name: 'What I remember' }).click();
  await expect(page.getByText(/deleted for real/)).toBeVisible();
  await expect(page.getByText(/Nothing is remembered yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete everything' }).click();
  await page.getByRole('button', { name: 'Yes, delete everything' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Everything stored under your session is deleted.',
  );
  await expect(page.getByLabel('You')).toHaveCount(0);
});

test('sends feedback and shows an empty memory view through the real API', async ({ page }) => {
  await ask(page, 'Hello there');
  await expect(page.getByLabel('Assistant')).toContainText(mockAnswer);
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const form = page.getByRole('form', { name: 'Feedback' });
  await form.getByLabel('Details').fill('Clear and short, thanks.');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Thanks. I review feedback before anything changes.',
  );
  await page.getByRole('button', { name: 'What I remember' }).click();
  await expect(page.getByText(/deleted for real/)).toBeVisible();
});

test('starts a new conversation', async ({ page }) => {
  await ask(page, 'First');
  await expect(page.getByLabel('Assistant')).toContainText(mockAnswer);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByLabel('You')).toHaveCount(0);
});
