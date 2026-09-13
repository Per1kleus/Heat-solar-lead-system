import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, EmptyState, ErrorBlock, Icon, Kpi, LoadingBlock } from '../components/ui';
import { money, date, relative, projectTypeLabel } from '../lib/format';

export default function Recovery() {
  const navigate = useNavigate();
  const { organization } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['recovery'],
    queryFn: () => get('/analytics/recovery'),
  });

  if (isLoading) return <div className="page"><LoadingBlock rows={4} height={90} /></div>;
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const groups = [
    { key: 'due_now', title: 'Due now', tone: 'alert' as const, help: 'The customer asked to be contacted around now.', items: data.due_now },
    { key: 'due_soon', title: 'Due in the next 30 days', tone: 'warn' as const, help: 'Get these into the diary.', items: data.due_soon },
    { key: 'scheduled', title: 'Scheduled further out', help: 'Recovery date recorded, nothing to do yet.', items: data.scheduled },
    { key: 'no_recovery_date', title: 'Recoverable, no date set', help: 'Worth deciding when to try again.', items: data.no_recovery_date },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Lost lead recovery</h1>
          <p className="muted small" style={{ margin: 0 }}>
            A lost lead is rarely lost forever. Postponed projects, financing and price objections come back.
          </p>
        </div>
      </div>

      <div className="kpi-grid mb-6">
        <Kpi label="Value sitting in lost leads" value={money(data.total_lost_value, currency)} />
        <Kpi label="Due to be contacted now" value={data.due_now.length} tone={data.due_now.length > 0 ? 'alert' : 'good'} />
        <Kpi label="Due within 30 days" value={data.due_soon.length} tone={data.due_soon.length > 0 ? 'warn' : undefined} />
        <Kpi label="Recovered so far" value={data.recovered?.n ?? 0} sub={money(data.recovered?.v ?? 0, currency)} tone="good" />
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div className="col gap-6">
          {groups.map((group) => (
            <Card key={group.key} title={`${group.title} (${group.items.length})`} subtitle={group.help} padded={false}>
              {group.items.length === 0 ? (
                <EmptyState icon="check" title="Nothing here" />
              ) : (
                <div>
                  {group.items.slice(0, 12).map((lead: any) => (
                    <button
                      key={lead.id} className="attention-item"
                      style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                      onClick={() => navigate(`/app/leads/${lead.id}`)}
                    >
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="strong truncate">{lead.first_name} {lead.last_name}</div>
                        <div className="tiny dim truncate">
                          {lead.reason ?? 'reason not recorded'} · lost {relative(lead.lost_at)}
                          {lead.city ? ` · ${lead.city}` : ''}
                          {lead.owner_first_name ? ` · ${lead.owner_first_name}` : ''}
                        </div>
                        {lead.lost_notes && <div className="tiny muted truncate">{lead.lost_notes}</div>}
                      </div>
                      <div className="right nowrap">
                        <div className="strong">{money(lead.estimated_value, currency)}</div>
                        {lead.recovery_date && <div className="tiny dim">{date(lead.recovery_date)}</div>}
                      </div>
                    </button>
                  ))}
                  {group.items.length > 12 && (
                    <div className="tiny dim" style={{ padding: '8px 12px' }}>+ {group.items.length - 12} more</div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>

        <Card title="Why deals are lost" subtitle="Where your pipeline leaks">
          {data.by_reason.length === 0 ? (
            <EmptyState icon="analytics" title="No lost leads yet" />
          ) : (
            <div className="col gap-4">
              {data.by_reason.map((row: any) => {
                const max = Math.max(...data.by_reason.map((r: any) => r.value), 1);
                return (
                  <div key={row.reason}>
                    <div className="row between small">
                      <span>{row.reason} <span className="dim">({row.count})</span></span>
                      <span className="strong">{money(row.value, currency)}</span>
                    </div>
                    <div className="progress" style={{ marginTop: 3 }}>
                      <i className="danger" style={{ width: `${(row.value / max) * 100}%` }} />
                    </div>
                  </div>
                );
              })}
              <div className="banner mt-4">
                <Icon name="target" size={15} />
                <span className="small">
                  If “price” or “chose a competitor” dominates, the fix is usually earlier in the process —
                  better qualification and a faster first quotation, not a bigger discount.
                </span>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
