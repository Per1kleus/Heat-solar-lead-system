import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorBlock, Icon, Kpi, LoadingBlock, ScoreRing, TemperatureBadge,
} from '../components/ui';
import { money, moneyShort, dateTime, relative, isOverdue, time, projectTypeLabel, percent } from '../lib/format';

export default function Dashboard() {
  const { user, organization } = useSession();
  const navigate = useNavigate();
  const currency = organization?.currency ?? 'EUR';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get('/dashboard'),
    refetchInterval: 180_000,
  });

  if (isLoading) {
    return (
      <div className="page">
        <div className="kpi-grid mb-6">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 82 }} />)}</div>
        <LoadingBlock rows={3} height={130} />
      </div>
    );
  }
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const k = data.kpis;
  const a = data.needs_attention;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting}, {user?.first_name}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {data.scope === 'own'
              ? 'Your leads, your follow-ups, your numbers.'
              : 'Everything across the company.'}
          </p>
        </div>
        <div className="row gap-4">
          <Button icon="plus" variant="primary" onClick={() => navigate('/app/leads?new=1')}>New lead</Button>
        </div>
      </div>

      {/* ---- needs attention: the single most important panel ---- */}
      <AttentionPanel attention={a} total={data.attention_total} currency={currency} />

      {/* ---- KPIs ---- */}
      <div className="kpi-grid mt-6">
        <Kpi label="New leads today" value={k.new_leads_today} sub={`${k.new_leads_week} this week`} onClick={() => navigate('/app/leads?sort=created_at')} />
        <Kpi label="Follow-ups due today" value={k.follow_ups_due_today} tone={k.follow_ups_due_today > 0 ? 'warn' : undefined} onClick={() => navigate('/app/tasks?bucket=today')} />
        <Kpi label="Overdue follow-ups" value={k.overdue_follow_ups} tone={k.overdue_follow_ups > 0 ? 'alert' : 'good'} onClick={() => navigate('/app/tasks?bucket=overdue')} />
        <Kpi label="Quotes awaiting a response" value={k.quotes_awaiting} sub={money(k.quotes_awaiting_value, currency)} tone={k.quotes_awaiting > 0 ? 'warn' : undefined} onClick={() => navigate('/app/quotations?status=sent,viewed,awaiting_response')} />
        <Kpi label="Hot leads" value={k.hot_leads} tone={k.hot_leads > 0 ? 'alert' : undefined} onClick={() => navigate('/app/leads?temperature=hot')} />
        <Kpi label="Won this month" value={k.won_this_month} sub={money(k.revenue_this_month, currency)} tone="good" onClick={() => navigate('/app/leads?status=won')} />
        <Kpi label="Lost this month" value={k.lost_this_month} onClick={() => navigate('/app/leads?status=lost')} />
        <Kpi label="Conversion rate" value={percent(k.conversion_rate, 1)} sub="won of decided deals" />
        <Kpi label="Pipeline value" value={moneyShort(k.pipeline_value, currency)} sub={`${k.open_leads} open leads`} onClick={() => navigate('/app/pipeline')} />
        <Kpi label="Expected revenue" value={moneyShort(k.expected_revenue, currency)} sub="weighted by stage probability" onClick={() => navigate('/app/analytics?tab=forecast')} />
      </div>

      <div className="grid c2 mt-6" style={{ alignItems: 'start' }}>
        {/* ---- my queue: who do I contact, why, when, how much, what happened ---- */}
        <Card
          title="Your next contacts"
          subtitle="Ordered by when the next action is due"
          actions={<Button size="sm" onClick={() => navigate('/app/leads')}>All leads</Button>}
          padded={false}
        >
          {data.my_queue.length === 0 ? (
            <EmptyState
              icon="check" title="Nothing waiting"
              message="Every open lead has a scheduled next action, or you have no open leads."
              action={<Button size="sm" onClick={() => navigate('/app/leads?new=1')}>Add a lead</Button>}
            />
          ) : (
            <div>
              {data.my_queue.map((lead: any) => (
                <button
                  key={lead.id} className="attention-item" style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                  onClick={() => navigate(`/app/leads/${lead.id}`)}
                >
                  <ScoreRing score={lead.score} size={36} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row gap-4" style={{ minWidth: 0 }}>
                      <span className="strong truncate">{lead.full_name}</span>
                      <TemperatureBadge temperature={lead.temperature} />
                    </div>
                    <div className="tiny dim truncate">
                      {projectTypeLabel(lead.project_types)} · {lead.city ?? 'no city'} · {lead.stage_name}
                    </div>
                    <div className="small truncate" style={{ marginTop: 2, color: lead.next_task_due_at && isOverdue(lead.next_task_due_at) ? 'var(--danger)' : 'var(--ink-2)' }}>
                      {lead.next_task_title
                        ? <>→ {lead.next_task_title} · {relative(lead.next_task_due_at)}</>
                        : <span style={{ color: 'var(--warm)' }}>⚠ No next action scheduled</span>}
                    </div>
                  </div>
                  <div className="right nowrap">
                    <div className="strong">{money(lead.estimated_value, currency)}</div>
                    <div className="tiny dim">{lead.last_activity_at ? relative(lead.last_activity_at) : 'no activity'}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <div className="col gap-6">
          {/* ---- today's agenda ---- */}
          <Card
            title="Next 48 hours"
            actions={<Button size="sm" onClick={() => navigate('/app/calendar')}>Calendar</Button>}
            padded={false}
          >
            {data.today_agenda.length === 0 ? (
              <EmptyState icon="calendar" title="No appointments" message="Nothing scheduled in the next two days." />
            ) : (
              data.today_agenda.map((appt: any) => (
                <button
                  key={appt.id} className="attention-item" style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                  onClick={() => navigate(appt.lead_id ? `/app/leads/${appt.lead_id}` : '/app/calendar')}
                >
                  <div style={{ minWidth: 52 }}>
                    <div className="strong">{time(appt.starts_at)}</div>
                    <div className="tiny dim">{new Date(appt.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate strong">{appt.title}</div>
                    <div className="tiny dim truncate">
                      {appt.first_name ? `${appt.first_name} ${appt.last_name}` : ''}{appt.location ? ` · ${appt.location}` : ''}
                    </div>
                  </div>
                  <Badge tone="cold">{appt.type.replace('_', ' ')}</Badge>
                </button>
              ))
            )}
          </Card>

          {/* ---- pipeline snapshot ---- */}
          <Card
            title="Pipeline by stage"
            actions={<Button size="sm" onClick={() => navigate('/app/pipeline')}>Open board</Button>}
          >
            {data.stage_breakdown.every((s: any) => s.lead_count === 0) ? (
              <EmptyState icon="pipeline" title="The pipeline is empty" message="Leads appear here as soon as they arrive." />
            ) : (
              <div className="col gap-4">
                {data.stage_breakdown.map((stage: any) => {
                  const max = Math.max(...data.stage_breakdown.map((s: any) => s.value), 1);
                  return (
                    <button
                      key={stage.id}
                      onClick={() => navigate(`/app/leads?stage_id=${stage.id}`)}
                      style={{ border: 0, background: 'none', padding: 0, font: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <div className="row between" style={{ marginBottom: 3 }}>
                        <span className="row gap-4 small">
                          <span className="dot" style={{ color: stage.color }} />
                          {stage.name}
                          <span className="dim">{stage.lead_count}</span>
                        </span>
                        <span className="small strong">{moneyShort(stage.value, currency)}</span>
                      </div>
                      <div className="progress">
                        <i style={{ width: `${(stage.value / max) * 100}%`, background: stage.color }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function AttentionPanel({ attention, total, currency }: { attention: any; total: number; currency: string }) {
  const navigate = useNavigate();

  if (total === 0) {
    return (
      <Card>
        <div className="row gap-6">
          <span style={{ color: 'var(--good)' }}><Icon name="check" size={22} /></span>
          <div>
            <h2>Nothing needs your attention</h2>
            <p className="small muted" style={{ margin: 0 }}>
              No overdue follow-ups, no unanswered quotations, every open lead has a next action. Well played.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const groups: { key: string; mark: string; label: string; items: any[]; render: (item: any) => React.ReactNode; go: (item: any) => string }[] = [
    {
      key: 'overdue', mark: '🔴',
      label: `${attention.overdue_follow_ups.length} overdue follow-up${attention.overdue_follow_ups.length === 1 ? '' : 's'}`,
      items: attention.overdue_follow_ups,
      go: (t) => (t.lead_id ? `/app/leads/${t.lead_id}` : '/app/tasks'),
      render: (t) => (
        <>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate strong">{t.title}</div>
            <div className="tiny dim truncate">
              {t.first_name ? `${t.first_name} ${t.last_name} · ` : ''}due {dateTime(t.due_at)} ({relative(t.due_at)})
            </div>
          </div>
          {t.estimated_value ? <span className="small strong nowrap">{money(t.estimated_value, currency)}</span> : null}
        </>
      ),
    },
    {
      key: 'quotes', mark: '🟠',
      label: `${attention.quotes_awaiting.length} quote${attention.quotes_awaiting.length === 1 ? '' : 's'} awaiting a response`,
      items: attention.quotes_awaiting,
      go: (q) => `/app/quotations/${q.id}`,
      render: (q) => (
        <>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate strong">{q.number} — {q.first_name ? `${q.first_name} ${q.last_name}` : q.title}</div>
            <div className="tiny dim truncate">Sent {relative(q.sent_at)} · {q.status.replace('_', ' ')}</div>
          </div>
          <span className="small strong nowrap">{money(q.total, q.currency ?? currency)}</span>
        </>
      ),
    },
    {
      key: 'stale', mark: '🔥',
      label: `${attention.stale_hot_leads.length} hot lead${attention.stale_hot_leads.length === 1 ? '' : 's'} with no activity for ${attention.stale_hours} hours`,
      items: attention.stale_hot_leads,
      go: (l) => `/app/leads/${l.id}`,
      render: (l) => (
        <>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate strong">{l.first_name} {l.last_name}</div>
            <div className="tiny dim">Last activity {l.last_activity_at ? relative(l.last_activity_at) : 'never'} · score {l.score}</div>
          </div>
          <span className="small strong nowrap">{money(l.estimated_value, currency)}</span>
        </>
      ),
    },
    {
      key: 'noaction', mark: '⚠️',
      label: `${attention.no_next_action.length} lead${attention.no_next_action.length === 1 ? '' : 's'} without a next action`,
      items: attention.no_next_action,
      go: (l) => `/app/leads/${l.id}`,
      render: (l) => (
        <>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate strong">{l.first_name} {l.last_name}</div>
            <div className="tiny dim">Created {relative(l.created_at)} · nothing scheduled</div>
          </div>
          <span className="small strong nowrap">{money(l.estimated_value, currency)}</span>
        </>
      ),
    },
    {
      key: 'unassigned', mark: '👤',
      label: `${attention.unassigned.length} unassigned lead${attention.unassigned.length === 1 ? '' : 's'}`,
      items: attention.unassigned,
      go: (l) => `/app/leads/${l.id}`,
      render: (l) => (
        <>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate strong">{l.first_name} {l.last_name}</div>
            <div className="tiny dim">Arrived {relative(l.created_at)} · nobody owns it</div>
          </div>
          <span className="small strong nowrap">{money(l.estimated_value, currency)}</span>
        </>
      ),
    },
    {
      key: 'recovery', mark: '🔄',
      label: `${attention.recovery_due.length} lost lead${attention.recovery_due.length === 1 ? '' : 's'} due for recovery`,
      items: attention.recovery_due,
      go: (l) => `/app/leads/${l.id}`,
      render: (l) => (
        <>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate strong">{l.first_name} {l.last_name}</div>
            <div className="tiny dim">{l.reason} · recontact {relative(l.recovery_date)}</div>
          </div>
          <span className="small strong nowrap">{money(l.estimated_value, currency)}</span>
        </>
      ),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <Card
      title={<h2 className="row gap-4"><Icon name="alert" size={17} />Needs attention</h2>}
      subtitle={`${total} item${total === 1 ? '' : 's'} waiting on you`}
      padded={false}
    >
      <div className="attention-grid">
        {groups.map((group) => (
          <div key={group.key} className="attention-group">
            <div className="row gap-4" style={{ padding: '9px 12px', background: 'var(--surface-2)' }}>
              <span aria-hidden="true">{group.mark}</span>
              <span className="small strong grow">{group.label}</span>
            </div>
            {group.items.slice(0, 4).map((item: any) => (
              <button
                key={item.id} className="attention-item"
                style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', font: 'inherit' }}
                onClick={() => navigate(group.go(item))}
              >
                {group.render(item)}
                <Icon name="chevron" size={13} />
              </button>
            ))}
            {group.items.length > 4 && (
              <div className="tiny dim" style={{ padding: '6px 12px' }}>+ {group.items.length - 4} more</div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
