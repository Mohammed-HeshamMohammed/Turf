import { Faq, Icon, Reveal } from "./components.jsx";

const steps = [
  ["Import", "Bring your property lists into one workspace."],
  ["Review", "Check and rank the phone evidence you already have."],
  ["Prepare", "Keep context close. Live calling is not available yet."],
  ["Follow up", "Record the outcome and give the next step an owner."],
];

export function Home() {
  return <div className="deep-home">
    <section className="dh-hero" id="top" aria-labelledby="home-title">
      <img className="dh-orca" src="/brand/callerwhale-orca.png" width="629" height="360" alt="" aria-hidden="true" />
      <div className="dh-hero-copy">
        <p className="dh-label">01 / Property outreach workspace</p>
        <h1 id="home-title">Know the record.<br />Make the call.<br /><em>Keep it moving.</em></h1>
        <p className="dh-lead">Your property lists, phone evidence and follow-ups, together. Less time piecing things together before the next conversation.</p>
        <div className="dh-actions"><a className="dh-btn" href="/#request-access">Join the waitlist <Icon name="ArrowUpRight" size={18} /></a><a className="dh-link" href="/#workspace">Take a look inside <Icon name="ArrowRight" size={18} /></a></div>
        <p className="dh-fine">Desktop workspace · Currently by invitation</p>
      </div>
    </section>

    <section className="dh-window-section" id="workspace" aria-labelledby="workspace-title">
      <h2 id="workspace-title" className="dh-sr">The Caller Whale workspace</h2>
      <figure className="dh-window">
        <div className="dh-window-bar" aria-hidden="true"><i /><i /><i /><span>Calls · Caller Whale</span></div>
        <img src="/screens/calls.webp" width="1440" height="900" alt="Caller Whale sample Calls workspace showing a lead, call notes and follow-up controls." fetchPriority="high" />
      </figure>
      <p className="dh-caption">Sample data. Calling is a preview; live telephony is not available yet. <a href="/screens/calls.webp" target="_blank" rel="noreferrer">View full size</a></p>
    </section>

    <section className="dh-steps" id="workflow" aria-labelledby="steps-title">
      <p className="dh-label">02 / From the first record to the next conversation</p>
      <h2 id="steps-title">One record,<br /><em>start to finish.</em></h2>
      <ol>{steps.map(([title, text], i) => <li key={title}><span className="dh-num">0{i + 1}</span><h3>{title}</h3><p>{text}</p></li>)}</ol>
    </section>

    <section className="dh-stories" aria-label="Working with your property records">
      <Reveal as="article" className="dh-story">
        <figure><img src="/images/list-work.webp" width="1536" height="1024" alt="An operator organizing property records beside her notebook." loading="lazy" /></figure>
        <div><p className="dh-label">03 / Work the list</p><h2>A spreadsheet is <em>a starting point.</em></h2><p>Import your property records, map the columns and review the phone evidence. Keep the original information close as you decide who to contact.</p><a className="dh-link" href="/features#skip">Lists & phone evidence <Icon name="ArrowUpRight" size={18} /></a><p className="dh-fine">Review supplied numbers today. New-number discovery is planned.</p></div>
      </Reveal>
      <Reveal as="article" className="dh-story flip">
        <figure><img src="/images/team-handoff.webp" width="1536" height="1024" alt="Two colleagues discussing notes and a follow-up." loading="lazy" /></figure>
        <div><p className="dh-label">04 / Carry it forward</p><h2>Good notes make <em>a better handoff.</em></h2><p>What was discussed? What happens next? Keep the outcome, callback and relevant notes attached to the record, so the next person can pick up the work.</p><a className="dh-link" href="/features#crm">Records & follow-ups <Icon name="ArrowUpRight" size={18} /></a><p className="dh-fine">Team roles and handoffs are shown in the sample workspace.</p></div>
      </Reveal>
    </section>

    <section className="dh-practical" aria-label="Plans and data">
      <div><p className="dh-label">05 / Your workspace, your setup</p><h2>Start with the work <em>you actually do.</em></h2><p>Explore the CRM base and the features your team needs. Launch pricing is a draft; checkout is not open yet.</p><a className="dh-link" href="/pricing">Build your plan <Icon name="ArrowUpRight" size={18} /></a></div>
      <div className="dh-data"><Icon name="Export" size={30} /><h3>Your records stay useful.</h3><p>Work with local lists and exports on your desktop. Sign-in and online services need a connection.</p><a className="dh-link" href="/security">Data & security <Icon name="ArrowUpRight" size={18} /></a></div>
    </section>
    <Faq compact />
  </div>;
}
