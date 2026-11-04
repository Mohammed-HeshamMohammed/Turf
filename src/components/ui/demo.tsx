import { ResponsiveHeroBanner } from "./responsive-hero-banner.tsx";
import { SiteHeader } from "./site-header.tsx";
import type { Me } from "../../auth/auth-client.js";

/** Caller Whale's configuration of the supplied hero component. */
export function HeroDemo({ me, onSignOut }: { me: Me | null | undefined; onSignOut: () => void }) {
  return <ResponsiveHeroBanner
    header={<SiteHeader path="/" me={me} onSignOut={onSignOut} />}
    backgroundImageUrl="/screens/dashboard.webp"
    previewImageUrl="/screens/dashboard.webp"
    previewAlt="Caller Whale overview showing leads, next steps and pipeline value"
    navLinks={[{ label: "Features", href: "/features" }, { label: "Why Caller Whale", href: "/why-caller-whale" }, { label: "Pricing", href: "/pricing" }, { label: "Security", href: "/security" }]}
    badgeLabel="Caller Whale"
    badgeText="The calling workspace for lead teams"
    title="Every lead has"
    titleLine2="a next call."
    description="Keep your lists, calls, deal notes and team handoffs in one workspace, so you always know what to do next."
    primaryButtonText={me === undefined ? undefined : me ? "Your profile" : "Create an account"}
    primaryButtonHref={me ? "/account" : "/signup"}
    secondaryButtonText="Explore features"
    secondaryButtonHref="/features"
  />;
}
