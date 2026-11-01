# Landing web preferences

The homepage should show the app only once or twice at most. Keep one main product screenshot by default; use the remaining sections for the business story rather than repeating app captures or copying the desktop UI.

Use custom visual storytelling for the benefits, not text-only replacement sections: natural, candid human photography should show an operator organizing records, a caller with useful context, and colleagues handing off the next step. Keep houses mainly in the hero; avoid miniature houses, 3D models and abstract sculptural scenes in the benefit sections. Keep these marketing concepts distinct from actual app screenshots and be honest about preview-only capabilities.

Keep a persistent Get started entry point on public marketing pages, offering sign in, invitation-based sign up, the web dashboard, and the desktop download through the existing authorized account flow.

Responsive/motion changes must preserve readable headline glyphs at 320px (not merely hide overflow), separate hero copy from photos on tablets, and keep menu/dialog content scrollable in short landscape viewports. Use restrained, finite entrances; reduced motion and missing IntersectionObserver must leave all content visible. Run `npm run test:browser` for regressions.
