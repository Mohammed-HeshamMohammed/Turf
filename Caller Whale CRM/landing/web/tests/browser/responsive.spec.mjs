import { test, expect } from "@playwright/test";

for (const width of [320, 360, 390, 600, 760, 768, 960, 1024, 1440, 1920]) {
  test(`content fits ${width}px, including real headline glyphs`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const route of [
      "/",
      "/features",
      "/pricing",
      "/compare",
      "/security",
      "/contact",
      "/privacy",
      "/terms",
    ]) {
      await page.goto(route);
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      // A containing box can fit while its unbreakable text is clipped by overflow:hidden.
      if (route === "/") {
        const edges = await page.locator("h1").evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].map((rect) => rect.right);
        });
        expect(Math.max(...edges)).toBeLessThanOrEqual(width - 15);
        await expect(page.locator('main img[src^="/screens/"]')).toHaveCount(1);
      }
    }
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`menu and modal fit ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const headerHeight = await page
      .locator("header")
      .evaluate((e) => e.offsetHeight);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    expect(await page.locator("header").evaluate((e) => e.offsetHeight)).toBe(
      headerHeight,
    );
    expect(
      await page
        .locator("#site-nav")
        .evaluate((e) => e.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(viewport.height);
    await page
      .getByRole("link", { name: "Request access", exact: true })
      .scrollIntoViewIfNeeded();
    await page.keyboard.press("Escape");
    const trigger = page.getByRole("button", {
      name: "Get started",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCSS("opacity", "1");
    const rect = await dialog.boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.width).toBeLessThanOrEqual(viewport.width);
    expect(rect.height).toBeLessThanOrEqual(viewport.height - 20);
    await dialog
      .getByRole("link", { name: "Join the waitlist" })
      .scrollIntoViewIfNeeded();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(
      await page.locator("body").evaluate((e) => e.style.overflow),
    ).not.toBe("hidden");
  });
}

test("menu closes when changing to desktop layout", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator("#site-nav")).not.toBeVisible();
});

test("entrances finish; offscreen sections reveal on scroll", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator(".hero-copy")).toHaveCSS(
    "animation-name",
    "studio-enter",
  );
  await expect(page.locator(".hero-copy")).toHaveCSS("opacity", "1");
  const story = page.locator(".studio-story").last();
  await expect(story).toHaveClass(/motion-ready/);
  await expect(story).toHaveCSS("opacity", "0");
  await story.scrollIntoViewIfNeeded();
  await expect(story).toHaveClass(/\bin\b/);
  await expect(story).toHaveCSS("opacity", "1");
  await expect(story).toHaveCSS("transform", "none");
});

test("reduced motion stays visible, including a preference change", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const story = page.locator(".studio-story").last();
  await expect(story).toHaveClass(/motion-ready/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(story).toHaveCSS("opacity", "1");
  await expect(page.locator(".hero-copy")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("animation-name", "none");
});

test("public content stays visible when IntersectionObserver is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete window.IntersectionObserver;
  });
  await page.goto("/");
  await expect(page.locator(".studio-story").last()).toHaveCSS("opacity", "1");
});

test("tablet hero separates text from the photograph", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const copy = await page.locator(".hero-copy").boundingBox();
  const photo = await page.locator(".property-hero").boundingBox();
  expect(photo.y).toBeGreaterThanOrEqual(copy.y + copy.height - 1);
});

test("dark phone layout and independent FAQ keyboard interaction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const summaries = page.locator("#faq summary");
  await summaries.nth(0).focus();
  await page.keyboard.press("Enter");
  await summaries.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#faq details[open]")).toHaveCount(2);
  await expect(page.locator("#faq details").first().locator("p")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#faq details[open]")).toHaveCount(1);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCSS(
    "color",
    "rgb(244, 239, 231)",
  );
});

test("enlarged text reflows instead of clipping the hero", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const right = await page.locator("h1").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
  });
  expect(right).toBeLessThanOrEqual(375);
});
