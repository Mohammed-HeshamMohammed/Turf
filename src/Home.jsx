import { Faq, Icon, Reveal } from "./components.jsx";
import { Workflow } from "./Workflow.jsx";

export function Home() {
  return <div className="studio-home editorial-home">
    <section className="studio-hero" id="top" aria-labelledby="home-title">
      <div className="hero-copy">
        <p className="studio-label">A workspace for property outreach</p>
        <h1 id="home-title">Know the record.<br />Make the call.<br /><em>Keep it moving.</em></h1>
        <p className="studio-lead">Your property lists, phone evidence and follow-ups, together. Less time piecing things together before the next conversation.</p>
        <div className="actions"><a className="button" href="/#request-access">Join the waitlist <Icon name="ArrowUpRight" size={18} /></a><a className="studio-link" href="/#workspace">Take a look inside <Icon name="ArrowRight" size={18} /></a></div>
        <p className="hero-availability">Desktop workspace · Currently by invitation</p>
      </div>
      <figure className="property-hero">
        <picture><source media="(max-width: 600px)" srcSet="/images/property-hero-mobile.webp" /><img src="/images/property-hero.webp" width="1536" height="1024" alt="Residential homes in afternoon light, an illustrative property scene." fetchPriority="high" /></picture>
        <figcaption><span>The work starts with a property.</span><span>Keep the whole story with it.</span></figcaption>
      </figure>
    </section>

    <Workflow />

    <section className="workspace-proof editorial-workspace" id="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading"><p className="studio-label">Inside Caller Whale / 01</p><h2 id="workspace-title">The details you need.<br />Right where you work.</h2><p>A property record should carry its history. See the list, review the context and leave a useful next step.</p></div>
      <figure className="product-evidence"><a href="/screens/calls.webp" target="_blank" rel="noreferrer" aria-label="Open full-size Calls sample workspace screenshot"><img src="/screens/calls.webp" width="1440" height="900" alt="Caller Whale sample Calls workspace showing a lead, call notes and follow-up controls." loading="lazy" /></a><figcaption><span>Calls workspace · Product preview</span><a href="/screens/calls.webp" target="_blank" rel="noreferrer">View full size <Icon name="ArrowUpRight" size={16} /></a></figcaption></figure>
      <div className="workspace-notes"><p><strong>Before the call</strong>Property details and phone evidence, ready to review.</p><p><strong>During the conversation</strong>Notes and previous activity stay close at hand.</p><p><strong>After the call</strong>A recorded outcome and a follow-up with an owner.</p></div>
      <p className="preview-note">Shown with sample data. Calling is a preview; live telephony is not available yet.</p>
    </section>

    <section className="studio-stories editorial-stories" aria-label="Working with your property records">
      <Reveal as="article" className="studio-story">
        <figure><img src="/images/list-work.webp" width="1536" height="1024" alt="An operator organizing property records beside her notebook." loading="lazy" /><figcaption>Start with the records you already have.</figcaption></figure>
        <div className="story-copy"><p className="studio-label">Work the list / 02</p><h2>A spreadsheet is<br />a starting point.</h2><p>Import your property records, map the columns and review the phone evidence. Keep the original information close as you decide who to contact.</p><a className="studio-link" href="/features#skip">Lists & phone evidence <Icon name="ArrowUpRight" size={18} /></a><p className="story-detail">Review supplied numbers today. New-number discovery is planned.</p></div>
      </Reveal>
      <Reveal as="article" className="studio-story">
        <figure><img src="/images/team-handoff.webp" width="1536" height="1024" alt="Two colleagues discussing notes and a follow-up." loading="lazy" /><figcaption>Leave something useful for the next person.</figcaption></figure>
        <div className="story-copy"><p className="studio-label">Carry it forward / 03</p><h2>Good notes make<br />a better handoff.</h2><p>What was discussed? What happens next? Keep the outcome, callback and relevant notes attached to the record, so the next person can pick up the work.</p><a className="studio-link" href="/features#crm">Records & follow-ups <Icon name="ArrowUpRight" size={18} /></a><p className="story-detail">Team roles and handoffs are demonstrated in the sample workspace.</p></div>
      </Reveal>
    </section>

    <section className="editorial-practical" aria-label="Plans and data"><div><p className="studio-label">Your workspace, your setup</p><h2>Start with the work<br />you actually do.</h2><p>Explore the CRM base and the features your team needs. Launch pricing is a draft; checkout is not open yet.</p><a className="studio-link" href="/pricing">Build your plan <Icon name="ArrowUpRight" size={18} /></a></div><div className="data-note"><Icon name="Export" size={30} /><h3>Your records stay useful.</h3><p>Work with local lists and exports on your desktop. Sign-in and online services need a connection.</p><a className="studio-link" href="/security">Data & security <Icon name="ArrowUpRight" size={18} /></a></div></section>
    <Faq compact />
  </div>;
}
