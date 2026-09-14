import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorBlock, Icon, Kpi, LoadingBlock, ScoreRing, TemperatureBadge,
} from '../components/ui';
import { money, moneyShort, relative, isOverdue, time, projectTypeLabel, percent } from '../lib/format';
import LeadComposer from '../components/LeadComposer';
import AppointmentOutcome from '../components/AppointmentOutcome';

export default function Dashboard() {
  const { user, organization } = useSession();
  const navigate = useNavigate();
  const currency = organization?.currency ?? 'EUR';
  // The item the owner is acting on right now, if the action opens a dialog
  // rather than navigating.
  const [acting, setActing] = useState<any | null>(null);

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
  const hour = new Date().getHours();

  /** Do the thing from here when that is practical; otherwise open the record. */
  const act = (item: any) => {
    if ((item.action === 'contact' || item.action === 'follow_up') && item.lead_id) {
      setActing(item);
      return;
    }
    if (item.action === 'close_appointment' && item.appointment_id) {
      setActing(item);
      return;
    }
    if (item.action === 'create_quote' && item.lead_id) {
      navigate(`/app/quotations?new=1&lead_id=${item.lead_id}&survey_id=${item.survey_id}`);
      return;
    }
    navigate(item.link);
  };
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

      {/* ---- what to do now: the single most important panel ---- */}
      <ActionPanel
        items={data.attention ?? []}
        counts={data.attention_counts ?? {}}
        urgent={data.urgent_total ?? 0}
        currency={currency}
        onAct={act}
      />

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

      {acting && (acting.action === 'contact' || acting.action === 'follow_up') && (
        <LeadComposer
          leadId={acting.lead_id}
          channel="whatsapp"
          templateKey={acting.action === 'follow_up' ? 'quote_follow_up' : undefined}
          quotationId={acting.quotation_id ?? undefined}
          onClose={() => setActing(null)}
          onSent={() => { setActing(null); refetch(); }}
        />
      )}
      {acting && acting.action === 'close_appointment' && (
        <AppointmentOutcome
          appointment={{
            id: acting.appointment_id,
            title: acting.context ?? acting.name,
            starts_at: acting.due_at,
          }}
          onClose={() => setActing(null)}
          onSaved={() => { setActing(null); refetch(); }}
        />
      )}
    </div>
  );
}

const KIND_META: Record<string, { mark: string; group: string }> = {
  overdue_task: { mark: '🔴', group: 'Overdue follow-ups' },
  appointment_missed: { mark: '📵', group: 'Appointments not closed off' },
  hot_lead: { mark: '🔥', group: 'Hot leads going quiet' },
  survey_to_quote: { mark: '📐', group: 'Surveys waiting for a quotation' },
  quote_viewed: { mark: '👀', group: 'Quotations opened, not answered' },
  quote_awaiting: { mark: '🟠', group: 'Quotations awaiting a response' },
  appointment_upcoming: { mark: '📅', group: 'Coming up' },
  no_next_action: { mark: '⚠️', group: 'No next action' },
  unassigned: { mark: '👤', group: 'Unassigned leads' },
  idle_lead: { mark: '🕓', group: 'No recent contact' },
  installation_due: { mark: '🔧', group: 'Installations' },
  recovery_due: { mark: '🔄', group: 'Lost leads worth revisiting' },
};

/**
 * The dashboard's working surface: what to do now, in priority order, each with
 * the button that does it. The list comes from the server already ranked — the
 * UI only decides how to draw it and which dialog a button opens.
 */
function ActionPanel({
  items, counts, urgent, currency, onAct,
}: {
  items: any[];
  counts: Record<string, number>;
  urgent: number;
  currency: string;
  onAct: (item: any) => void;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>('all');

  if (items.length === 0) {
    return (
      <Card>
        <div className="row gap-6">
          <span style={{ color: 'var(--good)' }}><Icon name="check" size={22} /></span>
          <div>
            <h2>Nothing needs your attention</h2>
            <p className="small muted" style={{ margin: 0 }}>
              No overdue follow-ups, no unanswered quotations, every survey quoted and every open
              lead has a next action. Well played.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const kinds = Object.keys(counts).sort(
    (a, b) => (items.findIndex((i) => i.kind === a)) - (items.findIndex((i) => i.kind === b)),
  );
  const shown = filter === 'all' ? items : items.filter((item) => item.kind === filter);

  return (
    <Card
      title={<h2 className="row gap-4"><Icon name="alert" size={17} />What needs you now</h2>}
      subtitle={
        urgent > 0
          ? `${urgent} urgent of ${items.length} — highest value first`
          : `${items.length} item${items.length === 1 ? '' : 's'} waiting on you`
      }
      padded={false}
    >
      <div className="card-body tight">
        <div className="chips">
          <button type="button" className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            Everything {items.length}
          </button>
          {kinds.map((kind) => (
            <button
              key={kind} type="button"
              className={`chip ${filter === kind ? 'on' : ''}`}
              onClick={() => setFilter(kind)}
            >
              <span aria-hidden="true">{KIND_META[kind]?.mark ?? '•'}</span>
              {KIND_META[kind]?.group ?? kind} {counts[kind]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)' }}>
        {shown.slice(0, 12).map((item) => (
          <div key={item.id} className="attention-item action-row">
            <span
              aria-hidden="true"
              title={KIND_META[item.kind]?.group ?? item.kind}
              style={{ fontSize: 15, width: 20, textAlign: 'center' }}
            >
              {KIND_META[item.kind]?.mark ?? '•'}
            </span>
            <button
              className="grow action-row-main"
              onClick={() => navigate(item.link)}
              style={{ minWidth: 0, textAlign: 'left', border: 0, background: 'none', font: 'inherit', cursor: 'pointer', padding: 0 }}
            >
              <div className="row gap-4" style={{ minWidth: 0 }}>
                <span className="strong truncate">{item.name}</span>
                {item.priority === 1 && <Badge tone="danger">Now</Badge>}
              </div>
              <div className="small truncate" style={{ color: 'var(--ink-2)' }}>{item.reason}</div>
              {item.context && <div className="tiny dim truncate">{item.context}</div>}
            </button>
            <div className="right nowrap" style={{ minWidth: 0 }}>
              {item.value ? <div className="small strong">{money(item.value, currency)}</div> : null}
            </div>
            <Button size="sm" variant="primary" onClick={() => onAct(item)}>{item.action_label}</Button>
          </div>
        ))}
        {shown.length > 12 && (
          <div className="tiny dim" style={{ padding: '8px 12px' }}>
            + {shown.length - 12} more in this group
          </div>
        )}
      </div>
    </Card>
  );
}
