import { Link } from "../../nav.tsx";
import { ResponsiveHeroBanner } from "./responsive-hero-banner.tsx";

/** Caller Whale's configuration of the supplied hero component. */
export function HeroDemo({ signedIn }: { signedIn: boolean | undefined }) {
  return <ResponsiveHeroBanner
    header={null}
    backgroundImageUrl="/hero.webp"
    navLinks={[{ label: "Features", href: "/features" }, { label: "Why Caller Whale", href: "/why-caller-whale" }, { label: "Pricing", href: "/pricing" }, { label: "Security", href: "/security" }]}
    badgeLabel="Caller Whale"
    badgeText="The calling workspace for lead teams"
    title="Every lead has"
    titleLine2="a next call."
    description="Keep your lists, calls, deal notes and team handoffs in one workspace, so you always know what to do next."
    primaryButtonText={signedIn === undefined ? undefined : signedIn ? "Your profile" : "Create an account"}
    primaryButtonHref={signedIn ? "/account" : "/signup"}
    secondaryButtonText="Explore features"
    secondaryButtonHref="/features"
  >
    {signedIn === false && <Link className="hero-side-cta" to="/signup">Start for free <span aria-hidden="true">↗</span></Link>}
  </ResponsiveHeroBanner>;
}
