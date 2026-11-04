import { Link } from "./nav.tsx";
import { PageHead, Screen } from "./ui.tsx";

export function WhyCallerWhale() {
  return <>
    <PageHead eyebrow="Why Caller Whale" title="One workspace for the whole lead journey." lead="A list, a call, a follow-up and a deal belong to the same record. Keep the context with the work instead of passing it between tools." />
    <section className="section feature-grid">
      <div className="feature-copy"><h2>Start with the source.</h2><p>Import a list, map its columns and keep the original. Work through the strongest phone numbers while notes and outcomes stay attached to the lead.</p><Link to="/features/import-lists">Explore list imports →</Link></div>
      <Screen file="lists" alt="Source lists in Caller Whale with record and check status" />
    </section>
    <section className="section feature-grid">
      <div className="feature-copy"><h2>Make the next step visible.</h2><p>Tasks, callbacks, deal stages and team handoffs all point back to the lead. Your team can see who owns the next action and what happened before it.</p><Link to="/features/crm">Explore the CRM →</Link></div>
      <Screen file="deals" alt="Deal board showing the stages from qualified to closed won" />
    </section>
    <section className="cta"><h2>Use the pieces you need.</h2><p>Features are priced individually; the plan builder shows the total before you sign up.</p><Link className="button primary" to="/pricing">Build your plan</Link></section>
  </>;
}
