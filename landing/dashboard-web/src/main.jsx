import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function Dashboard() {
  return <div className="workspace">
    <aside><a className="brand" href="/">Caller Whale<span>Workspace</span></a><nav aria-label="Dashboard"><a href="/" aria-current="page">Overview</a></nav><p>Business workspace</p></aside>
    <main><header><span>WORKSPACE / OVERVIEW</span><span className="status">Setup in progress</span></header>
      <section className="intro"><p className="eyebrow">YOUR BUSINESS, CONNECTED</p><h1>A clearer view of<br />what comes next.</h1><p>Your home for account access, usage, and business activity.</p></section>
      <section className="notice" aria-labelledby="setup-title"><span className="marker">01</span><div><h2 id="setup-title">Connect your workspace</h2><p>This dashboard is being prepared. Account access and live business data are not connected yet.</p></div></section>
      <section className="cards" aria-label="Planned workspace areas">{[
        ['Account', 'Your profile and workspace access.'],
        ['Usage', 'Credits and activity from your account.'],
        ['Downloads', 'Desktop releases and installation details.']
      ].map(([title, description]) => <article key={title}><span className="eyebrow">COMING NEXT</span><h2>{title}</h2><p>{description}</p></article>)}</section>
      <footer>Caller Whale · Dashboard foundation</footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<Dashboard />);
