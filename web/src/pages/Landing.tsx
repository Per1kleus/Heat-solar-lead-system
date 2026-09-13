import { Link } from 'react-router-dom';
import { Icon } from '../components/ui';
import { useTheme } from '../lib/session';

const FEATURES = [
  {
    icon: 'inbox' as const,
    title: 'Every enquiry lands in one place',
    body: 'Website form, phone, WhatsApp, Google and Meta ads, referrals, your own spreadsheet — all captured, de-duplicated and assigned the moment they arrive.',
  },
  {
    icon: 'clock' as const,
    title: 'Nothing is forgotten',
    body: 'Every lead carries an owner, a status, a temperature and a next action with a date. Anything without one is flagged on the dashboard until you deal with it.',
  },
  {
    icon: 'target' as const,
    title: 'Scoring built for this trade',
    body: 'Consumption, roof, heating cost, urgency, budget and engagement feed a score you can see the working behind — and change to match how you sell.',
  },
  {
    icon: 'quote' as const,
    title: 'Quotations that chase themselves',
    body: 'Build a proposal from your own price list, send a real PDF, and let the day 2 / 5 / 10 / 20 follow-up sequence run until the customer answers.',
  },
  {
    icon: 'survey' as const,
    title: 'Site surveys on a phone',
    body: 'Your technician gets the address, the checklist for PV or heat pumps, and a camera. The findings land on the lead before they leave the driveway.',
  },
  {
    icon: 'analytics' as const,
    title: 'Which channel actually pays',
    body: 'Leads, qualified, quotes, wins and revenue for every source. You will know within a month where your marketing budget belongs.',
  },
];

const PLANS = [
  {
    name: 'Starter', price: 79, blurb: 'For a small team getting every lead under control.',
    features: ['2 users', '250 leads a month', 'Pipeline and lead scoring', 'Quotations with PDF', 'Core follow-up automation'],
  },
  {
    name: 'Growth', price: 149, featured: true, blurb: 'Advanced automation, analytics and site surveys.',
    features: ['5 users', '1,000 leads a month', 'Everything in Starter', 'Custom automation builder', 'Full analytics and attribution', 'Technical site surveys', 'Email and WhatsApp integrations'],
  },
  {
    name: 'Pro', price: 249, blurb: 'Everything, including AI assistance and the open API.',
    features: ['15 users', 'Unlimited practical lead volume', 'Everything in Growth', 'AI summaries and suggested replies', 'Advanced revenue analytics', 'Open API and webhooks'],
  },
];

export default function Landing() {
  const [theme, setTheme] = useTheme();

  return (
    <div className="public-shell">
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <nav className="public-nav">
          <Link to="/" className="row gap-4" style={{ color: 'inherit', textDecoration: 'none', fontWeight: 700, fontSize: 16 }}>
            <span className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
                <path d="M17.5 5 9 18h5.5L13 27l9.5-14H17z" fill="currentColor" />
              </svg>
            </span>
            VoltaFlow
          </Link>
          <div className="row gap-4">
            <button
              className="btn ghost sm icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle colour theme"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
            <Link to="/login" className="btn sm">Sign in</Link>
            <Link to="/signup" className="btn primary sm">Start free</Link>
          </div>
        </nav>
      </header>

      <section className="hero">
        <span className="badge accent">Built for solar PV &amp; heat-pump installers</span>
        <h1 style={{ marginTop: 14 }}>Turn more solar &amp; heat-pump leads into customers.</h1>
        <p className="lede">
          Capture every inquiry, automate follow-ups, manage quotations, and give your sales team
          a clear view of every opportunity — all in one place.
        </p>
        <div className="row gap-6 wrap mt-6">
          <Link to="/signup" className="btn primary lg">Start free</Link>
          <a className="btn lg" href="mailto:hello@voltaflow.eu?subject=VoltaFlow%20demo">Book a demo</a>
        </div>
        <p className="small dim mt-4">14-day trial with sample data. No card required.</p>

        <div className="card mt-6" style={{ padding: 18 }}>
          <div className="small strong mb-2">The problem this solves</div>
          <p className="muted" style={{ fontSize: 15, maxWidth: '70ch', margin: 0 }}>
            “We receive leads, but some are forgotten, followed up too late, poorly qualified,
            or lost after sending a quotation.”
          </p>
          <div className="grid c4 mt-6">
            {[
              ['4', 'overdue follow-ups', 'alert'],
              ['7', 'quotes awaiting a response', 'warn'],
              ['5', 'hot leads gone quiet', 'alert'],
              ['3', 'leads with no next action', 'warn'],
            ].map(([n, label, tone]) => (
              <div key={label} className={`kpi ${tone}`}>
                <span className="kpi-label">Needs attention</span>
                <span className="kpi-value">{n}</span>
                <span className="kpi-sub">{label}</span>
              </div>
            ))}
          </div>
          <p className="small dim mt-4" style={{ marginBottom: 0 }}>
            This is the first thing your team sees each morning. Every item is one click from the lead.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 style={{ fontSize: 24, marginBottom: 6 }}>Everything the trade actually needs</h2>
        <p className="muted mb-6" style={{ maxWidth: '60ch' }}>
          Not a generic CRM with solar wording bolted on. The fields, stages, checklists and
          price lists are the ones your engineers and salespeople already use.
        </p>
        <div className="grid auto">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="feature">
              <span style={{ color: 'var(--accent)' }}><Icon name={feature.icon} size={20} /></span>
              <h3 style={{ marginTop: 10 }}>{feature.title}</h3>
              <p className="small muted" style={{ margin: 0 }}>{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="card" style={{ padding: 22 }}>
          <h2 style={{ fontSize: 20, marginBottom: 14 }}>From first enquiry to installation handover</h2>
          <div className="row wrap gap-4" style={{ fontSize: 13 }}>
            {[
              'Lead arrives', 'Assigned and scored', 'Salesperson contacts',
              'Site survey', 'Quotation sent', 'Follow-up sequence',
              'Customer accepts', 'Revenue recorded', 'Installation handover',
            ].map((step, index, arr) => (
              <span key={step} className="row gap-4">
                <span className="badge outline">{index + 1}. {step}</span>
                {index < arr.length - 1 && <span className="dim" aria-hidden="true">→</span>}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="pricing">
        <h2 style={{ fontSize: 24, marginBottom: 6 }}>Straightforward pricing</h2>
        <p className="muted mb-6">One subscription for the whole company. Change plan whenever you like.</p>
        <div className="grid c3">
          {PLANS.map((plan) => (
            <div key={plan.name} className={`price-card ${plan.featured ? 'featured' : ''}`}>
              <div className="row between">
                <h3>{plan.name}</h3>
                {plan.featured && <span className="badge accent">Most popular</span>}
              </div>
              <div>
                <span className="price-amount">€{plan.price}</span>
                <span className="muted small"> / month</span>
              </div>
              <p className="small muted" style={{ margin: 0 }}>{plan.blurb}</p>
              <ul className="price-list">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <span style={{ color: 'var(--accent)', marginTop: 2 }}><Icon name="check" size={14} /></span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Link to="/signup" className={`btn ${plan.featured ? 'primary' : ''} block`}>Start free</Link>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)', marginTop: 24 }}>
        <div className="section row between wrap gap-6" style={{ paddingTop: 20, paddingBottom: 20 }}>
          <div className="small muted">© {new Date().getFullYear()} VoltaFlow — lead and sales software for energy installers.</div>
          <div className="row gap-6 small">
            <Link to="/login">Sign in</Link>
            <Link to="/signup">Start free</Link>
            <a href="mailto:hello@voltaflow.eu">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
