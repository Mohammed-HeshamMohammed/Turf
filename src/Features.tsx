import { Link } from "./nav.tsx";
import { features, featureBySlug } from "./content/features.ts";
import { PageHead, Screen, StatusBadge } from "./ui.tsx";

export function FeaturesIndex() {
  return (
    <>
      <PageHead
        eyebrow="Features"
        title="Everything a lead goes through."
        lead="Eight features, each priced on its own. Every one is marked with what works today and what is coming."
      />
      <section className="section">
        <ul className="grid three" style={{ marginTop: 0 }}>
          {features.map(f => (
            <li className="card" key={f.slug}>
              <StatusBadge status={f.status} />
              <h3>
                <Link to={`/features/${f.slug}`}>{f.title}</Link>
              </h3>
              <p>{f.short}</p>
              <Link className="more" to={`/features/${f.slug}`}>
                See {f.title.toLowerCase()}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <Cta />
    </>
  );
}

export function FeaturePage({ slug }: { slug: string }) {
  const f = featureBySlug(slug);
  if (!f) return null;
  const others = features.filter(other => other.slug !== slug);
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/features">Features</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{f.title}</span>
      </nav>
      <PageHead eyebrow="Features" title={f.title} lead={f.pitch}>
        <div className="mt-4">
          <StatusBadge status={f.status} />
        </div>
      </PageHead>
      <section className="section feature">
        <div className="feature-grid">
          <div className="feature-copy">
            <p>{f.text}</p>
            <ul className="ticks">
              {f.points.map(point => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            {f.soon && (
              <div className="soon">
                <h2>Coming at launch</h2>
                <ul>
                  {f.soon.map(point => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="feature-shots">
            <Screen file={f.shot} alt={f.alt} />
            {f.extra?.map(extra => (
              <Screen key={extra.shot} file={extra.shot} alt={extra.alt} />
            ))}
          </div>
        </div>
      </section>
      <section className="section band" aria-labelledby="more-features">
        <h2 id="more-features">The rest of the workspace</h2>
        <ul className="chips mt-4">
          {others.map(other => (
            <li key={other.slug}>
              <Link to={`/features/${other.slug}`}>{other.title}</Link>
            </li>
          ))}
        </ul>
      </section>
      <Cta />
    </>
  );
}

function Cta() {
  return (
    <section className="cta">
      <h2>See what it costs</h2>
      <p>Build your plan feature by feature, then create your account.</p>
      <div className="actions">
        <Link className="button primary" to="/pricing">See pricing</Link>
        <Link className="button" to="/signup">Create an account</Link>
      </div>
    </section>
  );
}
