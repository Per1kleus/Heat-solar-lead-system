import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock } from '../components/ui';
import { money, date, dateTime, relative, label, projectTypeLabel } from '../lib/format';

export default function CustomerDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { organization } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => get(`/customers/${id}`),
  });

  if (isLoading) return <div className="page"><LoadingBlock rows={4} height={80} /></div>;
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const { customer, projects, leads, quotations, activities } = data;
  const openLeads = leads.filter((l: any) => l.status === 'open');

  return (
    <div className="page">
      <div className="row gap-4 mb-4 small">
        <Link to="/app/customers" className="muted" style={{ textDecoration: 'none' }}>Customers</Link>
        <span className="dim">/</span><span className="dim">{customer.full_name}</span>
      </div>

      <Card>
        <div className="row between wrap gap-6 top">
          <div>
            <h1>{customer.full_name}</h1>
            <div className="row gap-4 wrap small muted mt-2">
              {customer.company && <span>{customer.company}</span>}
              {customer.phone && <a href={`tel:${customer.phone}`}>{customer.phone}</a>}
              {customer.email && <a href={`mailto:${customer.email}`}>{customer.email}</a>}
              {customer.city && <span>{[customer.address, customer.postal_code, customer.city].filter(Boolean).join(', ')}</span>}
            </div>
            <div className="row gap-4 mt-2">
              {customer.marketing_consent
                ? <Badge tone="good">Marketing consent given</Badge>
                : <Badge>Operational messages only</Badge>}
              {customer.vat_number && <Badge outline>VAT {customer.vat_number}</Badge>}
            </div>
          </div>
          <div className="right">
            <div style={{ fontSize: 22, fontWeight: 700 }}>{money(customer.lifetime_value, currency)}</div>
            <div className="small muted">lifetime value · customer since {date(customer.became_customer_at)}</div>
          </div>
        </div>
      </Card>

      <div className="grid c2 mt-4" style={{ alignItems: 'start' }}>
        <div className="col gap-6">
          <Card title="Projects" subtitle="Each installation, past and planned" padded={false}>
            {projects.length === 0 ? (
              <EmptyState icon="projects" title="No projects yet" message="A project is created when a deal is won." />
            ) : (
              <div>
                {projects.map((project: any) => (
                  <button
                    key={project.id} className="attention-item"
                    style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                    onClick={() => navigate('/app/projects')}
                  >
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="strong truncate">{project.name}</div>
                      <div className="tiny dim">
                        {label(project.project_type)}{project.system_size ? ` · ${project.system_size}` : ''}
                        {project.planned_install_date ? ` · install ${date(project.planned_install_date)}` : ''}
                      </div>
                    </div>
                    <span className="strong nowrap">{money(project.contract_value, currency)}</span>
                    <Badge tone={project.installation_status === 'handed_over' ? 'good' : 'cold'}>{label(project.installation_status)}</Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card title="Opportunities" subtitle="Leads linked to this customer" padded={false}>
            {leads.length === 0 ? (
              <EmptyState icon="leads" title="No leads" />
            ) : (
              <div>
                {leads.map((lead: any) => (
                  <button
                    key={lead.id} className="attention-item"
                    style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                    onClick={() => navigate(`/app/leads/${lead.id}`)}
                  >
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate">{projectTypeLabel(JSON.parse(lead.project_types || '[]'))}</div>
                      <div className="tiny dim">{lead.reference} · {lead.stage_name ?? '—'} · {relative(lead.created_at)}</div>
                    </div>
                    <span className="strong nowrap">{money(lead.estimated_value, currency)}</span>
                    <Badge tone={lead.status === 'won' ? 'good' : lead.status === 'lost' ? 'danger' : lead.temperature}>
                      {lead.status === 'open' ? lead.temperature : label(lead.status)}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="col gap-6">
          {openLeads.length === 0 && projects.length > 0 && (
            <div className="banner info">
              <Icon name="target" size={15} />
              <div>
                <strong>Cross-sell opportunity</strong>
                <div className="small">
                  This customer has {projects.length} installation{projects.length === 1 ? '' : 's'} and no open enquiry.
                  A battery, EV charger or heat pump is often the natural next step.
                </div>
              </div>
            </div>
          )}

          <Card title="Quotations" padded={false}>
            {quotations.length === 0 ? (
              <EmptyState icon="quote" title="No quotations" />
            ) : quotations.map((quote: any) => (
              <button
                key={quote.id} className="attention-item"
                style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                onClick={() => navigate(`/app/quotations/${quote.id}`)}
              >
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate small strong">{quote.number}</div>
                  <div className="tiny dim truncate">{quote.title}</div>
                </div>
                <span className="strong nowrap">{money(quote.total, quote.currency ?? currency)}</span>
                <Badge>{label(quote.status)}</Badge>
              </button>
            ))}
          </Card>

          <Card title="Recent history" padded={false}>
            {activities.length === 0 ? <EmptyState icon="history" title="Nothing recorded" /> : (
              <div style={{ padding: 14 }}>
                <div className="timeline">
                  {activities.slice(0, 20).map((activity: any) => (
                    <div key={activity.id} className="tl-item">
                      <span className="tl-dot"><Icon name="dot" size={9} /></span>
                      <div className="tl-body">
                        <div className="small strong">{activity.title}</div>
                        <div className="tl-meta">
                          {dateTime(activity.occurred_at)}{activity.first_name ? ` · ${activity.first_name} ${activity.last_name}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {customer.notes && <Card title="Notes"><p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{customer.notes}</p></Card>}
        </div>
      </div>
    </div>
  );
}
