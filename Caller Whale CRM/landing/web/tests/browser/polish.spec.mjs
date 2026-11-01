import { test, expect } from "@playwright/test";

test("workflow flows, pauses globally, persists, and stays visible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const flow = page.locator("#workflow");
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute("data-running", "true");
  await expect(page.locator(".workflow-connector")).toHaveCount(3);
  const arrow = page.locator(".workflow-connector svg").first();
  await expect(arrow).toHaveCSS("animation-name", "workflow-flow");
  await page
    .locator("#workflow")
    .getByRole("button", { name: "Pause motion" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect(arrow).toHaveCSS("animation-name", "none");
  await expect(page.locator(".studio-story").last()).toHaveCSS("opacity", "1");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await page
    .locator("#workflow")
    .getByRole("button", { name: "Resume motion" })
    .click();
  await flow.scrollIntoViewIfNeeded();
  await expect(arrow).toHaveCSS("animation-name", "workflow-flow");
  await page.locator(".foot").scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute("data-running", "false");
  await expect(arrow).toHaveCSS("animation-play-state", "paused");
});

test("system reduced motion overrides flow and never hides content", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.locator("#workflow").getByRole("button", { name: "Reduced motion" }),
  ).toBeDisabled();
  await expect(page.locator(".workflow-connector svg").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(page.locator(".studio-story").last()).toHaveCSS("opacity", "1");
});

test("metadata follows navigation, account entry and browser history", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Build your plan" }).click();
  await expect(page).toHaveTitle(/Pricing/);
  await expect(page.locator("link[rel=canonical]")).toHaveAttribute(
    "href",
    "https://callerwhale.com/pricing",
  );
  const description = await page
    .locator("meta[name=description]")
    .getAttribute("content");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    description,
  );
  await expect(
    page.locator('meta[name="twitter:description"]'),
  ).toHaveAttribute("content", description);
  await page
    .locator("header")
    .getByRole("link", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator("meta[name=robots]")).toHaveAttribute(
    "content",
    "noindex,nofollow",
  );
  await expect(page.locator("link[rel=canonical]")).toHaveCount(0);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(
    0,
  );
  await page.goBack();
  await expect(page).toHaveTitle(/Pricing/);
  await expect(page.locator("link[rel=canonical]")).toHaveCount(1);
});

test("local discovery endpoints return XML, text and a browser manifest", async ({
  request,
}) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  expect(await sitemap.text()).toContain("<loc>https://callerwhale.com/</loc>");
  const robots = await request.get("/robots.txt");
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toContain(
    "Sitemap: https://callerwhale.com/sitemap.xml",
  );
  const manifest = await request.get("/manifest.json");
  expect((await manifest.json()).display).toBe("browser");
});
