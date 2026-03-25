import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export interface ProviderConfig {
  label: string;
  model: string;
  slug: string;
}

/**
 * Create a new thread by clicking the new-thread button on the first project.
 * The button uses `showOnHover` CSS, so we use `force: true`.
 */
export async function createNewThread(page: Page): Promise<void> {
  // Hover the first project header to reveal the new-thread button
  const projectHeader = page.locator(".group\\/project-header").first();
  await projectHeader.hover();

  // Click the new-thread button (force because it's hidden until hover)
  await page.locator('[data-testid="new-thread-button"]').first().click({ force: true });

  // Wait for navigation to a thread route (UUID pattern)
  await page.waitForURL(/\/[0-9a-f]{8}-[0-9a-f]{4}-/, { timeout: 15_000 });

  // Wait for the composer editor to be ready
  await expect(page.locator('[data-testid="composer-editor"]')).toBeVisible({ timeout: 10_000 });
}

/**
 * Select a provider and model from the ProviderModelPicker.
 * Assumes the provider is not locked (fresh thread, no messages sent).
 */
export async function selectProvider(page: Page, provider: ProviderConfig): Promise<void> {
  // Click the provider picker trigger (button with chevron in the composer footer)
  const footer = page.locator('[data-chat-composer-footer="true"]');
  const pickerTrigger = footer.locator("button").first();
  await pickerTrigger.click();

  // Hover the provider submenu trigger to open the submenu popup
  const subTrigger = page.getByRole("menuitem", { name: provider.label });
  await subTrigger.hover();

  // Wait for the submenu to appear, then click the model
  const modelItem = page.getByRole("menuitemradio", { name: provider.model, exact: true });
  await expect(modelItem).toBeVisible({ timeout: 5_000 });
  await modelItem.click();

  // Verify the picker now shows the selected model
  await expect(pickerTrigger).toContainText(provider.model, { timeout: 5_000 });
}

/**
 * Type a message into the Lexical composer editor and send it.
 * Uses keyboard.type() because Lexical's contenteditable doesn't support fill().
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-testid="composer-editor"]');
  await editor.click();
  await page.keyboard.type(text, { delay: 20 });

  // Wait for the send button to be enabled
  const sendButton = page.locator('button[aria-label="Send message"]');
  await expect(sendButton).toBeEnabled({ timeout: 5_000 });
  await sendButton.click();

  // Wait for the user message to appear in the timeline
  await expect(page.locator('[data-message-role="user"]').last()).toContainText(text, {
    timeout: 10_000,
  });
}

/**
 * Wait for the assistant to finish responding.
 * Returns the last assistant message locator.
 */
export async function waitForResponse(page: Page, timeout = 90_000): Promise<Locator> {
  // Wait for either the stop button (provider started) or an assistant message
  await Promise.race([
    page
      .locator('button[aria-label="Stop generation"]')
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => {}),
    page
      .locator("[data-message-role='assistant']")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => {}),
  ]);

  // Wait for the send button to reappear (turn complete)
  await expect(page.locator('button[aria-label="Send message"]')).toBeVisible({ timeout });

  // Return the last assistant message
  const assistantMessages = page.locator("[data-message-role='assistant']");
  await expect(assistantMessages.last()).toBeVisible({ timeout: 30_000 });
  return assistantMessages.last();
}
