import { test, expect } from '@playwright/test';

test('homepage has SealShell in title', async ({ page }) => {
  await page.goto('/tests/app-harness.html');
  await expect(page).toHaveTitle(/SealShell/);
});
