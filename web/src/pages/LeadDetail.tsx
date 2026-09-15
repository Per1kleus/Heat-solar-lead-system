import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, newRequestId, post, patch } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBlock, Icon, LoadingBlock,
  Modal, ScoreRing, Tabs, TemperatureBadge, useToast, type IconName,
} from '../components/ui';
import LeadForm from '../components/LeadForm';
import MessageComposer from '../components/MessageComposer';
import CommunicationPanel from '../components/CommunicationPanel';
import AppointmentOutcome from '../components/AppointmentOutcome';
import AppointmentDialog from '../components/AppointmentDialog';
import {
  money, dateTime, relative, isOverdue, projectTypeLabel, label, date, toInputDateTime,
  fromInputDateTime, PRIORITY_META,
} from '../lib/format';

export default function LeadDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { organization, can, aiAvailable, hasFeature, user } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const [tab, setTab] = useState('timeline');
  const [dialog, setDialog] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const leadQuery = useQuery({
    queryKey: ['lead', id],
    queryFn: () => get(`/leads/${id}`),
  });
  const activityQuery = useQuery({
    queryKey: ['lead-activities', id],
    queryFn: () => get(`/leads/${id}/activities?limit=120`),
    enabled: Boolean(id),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['lead', id] });
    queryClient.invalidateQueries({ queryKey: ['lead-activities', id] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  if (leadQuery.isLoading) return <div className="page"><LoadingBlock rows={4} height={90} /></div>;
  if (leadQuery.error) return <div className="page"><ErrorBlock error={leadQuery.error} onRetry={leadQuery.refetch} /></div>;

  const {
    lead, completeness, quotations, tasks, appointments, surveys, documents,
    automation_runs: runs, messages = [], last_contact: lastContact = null,
  } = leadQuery.data;
  const openTasks = tasks.filter((t: any) => t.status === 'open');
  const nextTask = openTasks[0];

  return (
    <div className="page">
      <div className="row gap-4 mb-4 small">
        <Link to="/app/leads" className="row gap-2 muted" style={{ textDecoration: 'none' }}>
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="chevron" size={13} /></span>
          Back to leads
        </Link>
        <span className="dim">/</span>
        <span className="dim mono">{lead.reference}</span>
      </div>

      {/* ---------- header ---------- */}
      <Card padded={false}>
        <div className="card-body">
          <div className="row between wrap gap-6 top">
            <div className="row gap-6" style={{ minWidth: 0 }}>
              <ScoreRing score={lead.score} size={50} />
              <div style={{ minWidth: 0 }}>
                <div className="row gap-4 wrap">
                  <h1 className="truncate">{lead.full_name}</h1>
                  <TemperatureBadge temperature={lead.temperature} />
                  {lead.status !== 'open' && (
                    <Badge tone={lead.status === 'won' ? 'good' : 'danger'}>
                      {label(lead.status)}{lead.lost_reason_name ? `: ${lead.lost_reason_name}` : ''}
                    </Badge>
                  )}
                  {lead.automation_paused && <Badge tone="warm">Automation paused</Badge>}
                  {lead.duplicate_of && <Badge tone="warm">Possible duplicate</Badge>}
                </div>
                <div className="row gap-4 wrap small muted" style={{ marginTop: 4 }}>
                  {lead.company && <span>{lead.company}</span>}
                  <span>{projectTypeLabel(lead.project_types)}</span>
                  {lead.city && <span>{lead.city}</span>}
                  {lead.source_name && <span>via {lead.source_name}</span>}
                  <span>created {relative(lead.created_at)}</span>
                </div>
                <div className="row gap-4 wrap mt-2">
                  {lead.tags?.map((tag: any) => <Badge key={tag.id} outline>{tag.name}</Badge>)}
                </div>
              </div>
            </div>

            <div className="right">
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em' }}>{money(lead.estimated_value, currency)}</div>
              <div className="small muted">{lead.probability}% · {lead.stage_name ?? 'No stage'}</div>
              {lead.expected_close_date && <div className="tiny dim">Expected {date(lead.expected_close_date)}</div>}
              <div className="row gap-4 end mt-2">
                {lead.owner_name ? (
                  <span className="row gap-4"><Avatar name={lead.owner_name} color={lead.owner_color} size="sm" /><span className="small">{lead.owner_name}</span></span>
                ) : <Badge tone="warm">Unassigned</Badge>}
              </div>
            </div>
          </div>
        </div>

        {/* ---------- quick actions ---------- */}
        <div className="card-body tight row gap-4 wrap" style={{ borderTop: '1px solid var(--border)' }}>
          <QuickAction icon="phone" label="Call" disabled={!lead.phone}
            onClick={() => setDialog('call')} title={lead.phone ?? 'No phone number on file'} />
          <QuickAction icon="whatsapp" label="WhatsApp" disabled={!lead.phone} onClick={() => setDialog('whatsapp')} />
          <QuickAction icon="mail" label="Email" disabled={!lead.email} onClick={() => setDialog('email')} title={lead.email ?? 'No email on file'} />
          <QuickAction icon="note" label="Note" onClick={() => setDialog('note')} />
          <QuickAction icon="tasks" label="Task" onClick={() => setDialog('task')} />
          <QuickAction icon="calendar" label="Appointment" onClick={() => setDialog('appointment')} />
          {can('quotes:write') && <QuickAction icon="quote" label="Quotation" onClick={() => navigate(`/app/quotations?new=1&lead_id=${lead.id}`)} />}
          <QuickAction icon="upload" label="Upload" onClick={() => setDialog('upload')} />
          <div className="grow" />
          {can('leads:write') && <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
          {can('leads:write') && lead.status === 'open' && (
            <>
              <Button size="sm" onClick={() => setDialog('stage')}>Change stage</Button>
              <Button size="sm" variant="primary" onClick={() => setDialog('won')}>Mark won</Button>
              <Button size="sm" onClick={() => setDialog('lost')}>Mark lost</Button>
            </>
          )}
          {can('leads:write') && lead.status !== 'open' && (
            <Button size="sm" onClick={async () => { await post(`/leads/${id}/reopen`); refresh(); toast.success('Lead reopened.'); }}>Reopen</Button>
          )}
          {can('leads:assign') && <Button size="sm" onClick={() => setDialog('assign')}>Assign</Button>}
        </div>
      </Card>

      {/* ---------- next action ---------- */}
      <div className="mt-4">
        {nextTask ? (
          <div className={`next-action ${isOverdue(nextTask.due_at) ? 'overdue' : ''}`}>
            <div style={{ minWidth: 0 }}>
              <div className="next-action-label">Next action</div>
              <div style={{ fontSize: 16, fontWeight: 620, marginTop: 2 }}>{nextTask.title}</div>
              <div className="small" style={{ marginTop: 2 }}>
                Due {dateTime(nextTask.due_at)} ({relative(nextTask.due_at)})
                {isOverdue(nextTask.due_at) && <strong> — overdue</strong>}
                {nextTask.assignee_first_name && ` · ${nextTask.assignee_first_name} ${nextTask.assignee_last_name}`}
              </div>
              {nextTask.description && <div className="small muted" style={{ marginTop: 3 }}>{nextTask.description}</div>}
            </div>
            <div className="row gap-4">
              <Button
                variant="primary" size="sm"
                onClick={async () => { await post(`/tasks/${nextTask.id}/complete`, {}); refresh(); toast.success('Follow-up completed.'); }}
              >
                Complete
              </Button>
              <Button size="sm" onClick={() => setDialog(`reschedule:${nextTask.id}`)}>Reschedule</Button>
            </div>
          </div>
        ) : lead.status === 'open' ? (
          <div className="next-action none">
            <div>
              <div className="next-action-label">⚠ No next action</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>This lead has nothing scheduled.</div>
              <div className="small muted">Leads without a next action are the ones that get forgotten.</div>
            </div>
            <Button variant="primary" size="sm" onClick={() => setDialog('task')}>Schedule the next step</Button>
          </div>
        ) : null}
      </div>

      <div className="grid split mt-4">
        {/* ---------- main column ---------- */}
        <div className="col gap-6">
          <Card padded={false}>
            <div style={{ padding: '0 14px' }}>
              <Tabs
                active={tab} onChange={setTab}
                tabs={[
                  { key: 'timeline', label: 'Timeline', count: activityQuery.data?.total },
                  { key: 'tasks', label: 'Follow-ups', count: openTasks.length },
                  { key: 'quotes', label: 'Quotations', count: quotations.length },
                  { key: 'surveys', label: 'Surveys & visits', count: surveys.length + appointments.length },
                  { key: 'files', label: 'Files', count: documents.length },
                  { key: 'automation', label: 'Automation', count: runs.filter((r: any) => r.status === 'active').length },
                ]}
              />
            </div>
            <div className="card-body">
              {tab === 'timeline' && <Timeline query={activityQuery} onAdd={() => setDialog('note')} />}
              {tab === 'tasks' && <TaskList tasks={tasks} onRefresh={refresh} onAdd={() => setDialog('task')} />}
              {tab === 'quotes' && <QuoteList quotations={quotations} currency={currency} leadId={lead.id} />}
              {tab === 'surveys' && <SurveyList surveys={surveys} appointments={appointments} leadId={lead.id} onAdd={() => setDialog('appointment')} onRefresh={refresh} />}
              {tab === 'files' && <FileList documents={documents} onAdd={() => setDialog('upload')} />}
              {tab === 'automation' && <AutomationList runs={runs} lead={lead} onRefresh={refresh} />}
            </div>
          </Card>
        </div>

        {/* ---------- side column ---------- */}
        <div className="col gap-6">
          <CommunicationPanel
            lead={lead}
            messages={messages}
            lastContact={lastContact}
            onCall={() => setDialog('call')}
            onRefresh={refresh}
          />
          <ProjectSummary lead={lead} completeness={completeness} />
          <ScoreCard lead={lead} onRescore={async () => { await post(`/leads/${id}/rescore`); refresh(); }} />
          {(aiAvailable || hasFeature('ai')) && <AiPanel leadId={lead.id} available={aiAvailable} />}
          <ContactCard lead={lead} currency={currency} />
        </div>
      </div>

      {/* ---------- dialogs ---------- */}
      {editing && (
        <LeadForm
          mode="edit" initial={lead}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh(); }}
        />
      )}
      {dialog === 'note' && <ActivityDialog leadId={id} type="note" onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'call' && <CallDialog lead={lead} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'email' && <MessageComposer lead={lead} channel="email" onClose={() => setDialog(null)} onSent={refresh} />}
      {dialog === 'whatsapp' && <MessageComposer lead={lead} channel="whatsapp" onClose={() => setDialog(null)} onSent={refresh} />}
      {dialog === 'task' && <TaskDialog leadId={id} defaultAssignee={lead.owner_id ?? user?.id} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'appointment' && <AppointmentDialog lead={lead} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'upload' && <UploadDialog leadId={id} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'stage' && <StageDialog lead={lead} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'assign' && <AssignDialog lead={lead} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'won' && <WonDialog lead={lead} currency={currency} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === 'lost' && <LostDialog lead={lead} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog?.startsWith('reschedule:') && (
        <RescheduleDialog taskId={dialog.split(':')[1]} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
    </div>
  );
}

function QuickAction({ icon, label: text, onClick, disabled, title }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <Button size="sm" icon={icon} onClick={onClick} disabled={disabled} title={title}>
      <span className="hide-mobile">{text}</span>
    </Button>
  );
}

// ---------- panels ----------

function ProjectSummary({ lead, completeness }: { lead: any; completeness: any }) {
  const pv: [string, any][] = [
    ['System size', lead.pv_desired_kwp && `${lead.pv_desired_kwp} kWp`],
    ['Annual consumption', lead.pv_annual_kwh && `${Number(lead.pv_annual_kwh).toLocaleString()} kWh`],
    ['Monthly bill', lead.pv_monthly_bill && money(lead.pv_monthly_bill)],
    ['Roof', [lead.pv_roof_type, lead.pv_roof_orientation].filter(Boolean).join(', ').replace(/_/g, ' ')],
    ['Roof area', lead.pv_roof_area_m2 && `${lead.pv_roof_area_m2} m²`],
    ['Shading', lead.pv_shading],
    ['Property', lead.pv_property_type?.replace('_', ' ')],
    ['Supply', lead.pv_phase === 'three' ? 'Three phase' : lead.pv_phase === 'single' ? 'Single phase' : null],
    ['Grid connection', lead.pv_grid_connection?.replace(/_/g, ' ')],
    ['Existing PV', lead.pv_existing_system ? 'Yes' : null],
    ['Battery', lead.battery_interest ? (lead.battery_kwh ? `Yes — ${lead.battery_kwh} kWh` : 'Interested') : null],
    ['EV charger', lead.ev_charger_interest ? (lead.ev_charger_kw ? `Yes — ${lead.ev_charger_kw} kW` : 'Interested') : null],
    ['Backup power', lead.backup_power_interest ? 'Yes' : null],
  ];
  const hp: [string, any][] = [
    ['Existing system', lead.hp_existing_system?.replace(/_/g, ' ')],
    ['Annual heating cost', lead.hp_annual_heating_cost && money(lead.hp_annual_heating_cost)],
    ['Heated area', lead.hp_property_m2 && `${lead.hp_property_m2} m²`],
    ['Floors', lead.hp_floors],
    ['Emitters', lead.hp_emitters?.replace(/_/g, ' ')],
    ['Insulation', lead.hp_insulation],
    ['Estimated power', lead.hp_estimated_kw && `${lead.hp_estimated_kw} kW`],
    ['Hot water', lead.hp_dhw_required ? (lead.hp_dhw_litres ? `Yes — ${lead.hp_dhw_litres} L` : 'Yes') : null],
    ['Cooling', lead.hp_cooling_required ? 'Yes' : null],
    ['Remove old system', lead.hp_removal_required ? 'Yes' : null],
  ];
  const showPv = lead.pv_interest || lead.project_types?.some((t: string) => ['pv', 'battery', 'ev_charger'].includes(t));
  const showHp = lead.hp_interest || lead.project_types?.includes('heat_pump');

  return (
    <Card title="Project" subtitle={projectTypeLabel(lead.project_types)}>
      {showPv && <FactList title="Photovoltaic" items={pv} />}
      {showHp && <FactList title="Heat pump" items={hp} />}
      {lead.urgency && lead.urgency !== 'unknown' && (
        <div className="row gap-4 mt-4 small">
          <Icon name="clock" size={14} />
          <span>Wants to proceed: <strong>{label(lead.urgency)}</strong></span>
        </div>
      )}
      {lead.budget_known && (
        <div className="row gap-4 small" style={{ marginTop: 4 }}>
          <Icon name="euro" size={14} />
          <span>Budget: <strong>{lead.budget_amount ? money(lead.budget_amount) : 'discussed'}</strong></span>
        </div>
      )}
      {lead.notes && (
        <div className="mt-4">
          <div className="tiny dim strong" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>Notes</div>
          <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 3 }}>{lead.notes}</div>
        </div>
      )}
      {completeness.missing.length > 0 && (
        <div className="banner warn mt-4">
          <Icon name="alert" size={15} />
          <div>
            <div className="strong">Missing before you can quote accurately</div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {completeness.missing.map((item: string) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Upper-cases only the first letter, so units like kWp, kWh and m2 survive. */
function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function FactList({ title, items }: { title: string; items: [string, any][] }) {
  const filled = items.filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false);
  if (filled.length === 0) return null;
  return (
    <div className="mb-4">
      <div className="tiny dim strong mb-2" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>{title}</div>
      <dl className="kv">
        {filled.map(([key, value]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt>{key}</dt>
            <dd>{sentence(String(value))}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ScoreCard({ lead, onRescore }: { lead: any; onRescore: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const breakdown = lead.score_breakdown ?? [];
  return (
    <Card
      title="Why this score"
      subtitle={`${lead.score}/100 — ${lead.temperature}`}
      actions={
        <Button
          size="sm" icon="refresh" loading={busy}
          onClick={async () => { setBusy(true); try { await onRescore(); } finally { setBusy(false); } }}
          title="Recalculate"
        />
      }
    >
      {breakdown.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          Nothing has scored yet. The score rises as you record consumption, book a visit, issue a quotation
          and the customer engages.
        </p>
      ) : (
        <div className="col gap-2">
          {breakdown.map((factor: any) => (
            <div key={factor.key} className="row gap-4 small">
              <span
                className="mono strong nowrap"
                style={{ width: 34, textAlign: 'right', color: factor.points > 0 ? 'var(--good)' : 'var(--danger)' }}
              >
                {factor.points > 0 ? '+' : ''}{factor.points}
              </span>
              <span className="grow">
                {factor.label}
                {factor.detail && <span className="dim"> — {factor.detail}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="small dim mt-4">
        Scored {lead.scored_at ? relative(lead.scored_at) : 'never'}. Change the weights in Settings → Lead scoring.
      </div>
    </Card>
  );
}

function ContactCard({ lead, currency }: { lead: any; currency: string }) {
  return (
    <Card title="Contact">
      <dl className="kv">
        {lead.phone && <><dt>Phone</dt><dd><a href={`tel:${lead.phone}`}>{lead.phone}</a></dd></>}
        {lead.email && <><dt>Email</dt><dd><a href={`mailto:${lead.email}`} className="truncate" style={{ display: 'block' }}>{lead.email}</a></dd></>}
        {lead.address && <><dt>Address</dt><dd>{lead.address}</dd></>}
        {(lead.city || lead.postal_code) && <><dt>City</dt><dd>{[lead.postal_code, lead.city].filter(Boolean).join(' ')}</dd></>}
        <dt>Prefers</dt><dd>{label(lead.preferred_contact ?? 'phone')}</dd>
        <dt>Source</dt><dd>{lead.source_name ?? '—'}{lead.campaign ? ` · ${lead.campaign}` : ''}</dd>
        <dt>Created</dt><dd>{dateTime(lead.created_at)}</dd>
        <dt>First contacted</dt><dd>{lead.first_contacted_at ? relative(lead.first_contacted_at) : <span className="dim">not yet</span>}</dd>
        <dt>Last activity</dt><dd>{lead.last_activity_at ? relative(lead.last_activity_at) : '—'}</dd>
        {lead.customer_id && <><dt>Customer record</dt><dd><Link to={`/app/customers/${lead.customer_id}`}>Open customer</Link></dd></>}
        <dt>Marketing consent</dt>
        <dd>{lead.consent_marketing ? <Badge tone="good">Given</Badge> : <Badge>Not given</Badge>}</dd>
      </dl>
      {lead.status === 'lost' && lead.recovery_date && (
        <div className="banner info mt-4">
          <Icon name="refresh" size={15} />
          <span>Recovery scheduled for {date(lead.recovery_date)}.</span>
        </div>
      )}
      {lead.status === 'won' && (
        <div className="banner success mt-4">
          <Icon name="check" size={15} />
          <span>Won {relative(lead.won_at)} — {money(lead.estimated_value, currency)} recorded.</span>
        </div>
      )}
    </Card>
  );
}

function AiPanel({ leadId, available }: { leadId: string; available: boolean }) {
  const [result, setResult] = useState<{ text: string; source: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const run = async (task: string) => {
    setBusy(task);
    setResult(null);
    try {
      const data = await post(`/ai/leads/${leadId}`, { task });
      setResult({ text: data.text, source: data.source });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={<h2 className="row gap-4"><Icon name="sparkles" size={16} />AI assist</h2>}>
      {!available && (
        <div className="banner mb-4">
          <Icon name="alert" size={15} />
          <span>
            AI is not connected. Add an Anthropic API key in Settings → Communication to enable summaries
            and suggested replies. The “what is missing” check works without it.
          </span>
        </div>
      )}
      <div className="row gap-4 wrap">
        {[
          ['summary', 'Summarise lead'],
          ['conversation', 'Summarise conversation'],
          ['next_action', 'Suggest next action'],
          ['reply', 'Draft a reply'],
          ['qualification', 'What is missing?'],
        ].map(([task, text]) => (
          <Button key={task} size="sm" loading={busy === task} onClick={() => run(task)}>{text}</Button>
        ))}
      </div>
      {result && (
        <div className="mt-4">
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, background: 'var(--surface-3)', padding: 11, borderRadius: 'var(--radius-sm)' }}>
            {result.text}
          </div>
          <div className="row between mt-2">
            <span className="tiny dim">
              {result.source === 'ai'
                ? 'Generated from this lead record. Review before sending — never quote figures it did not have.'
                : 'Derived from the lead record.'}
            </span>
            <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(result.text); toast.success('Copied.'); }}>Copy</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------- tab content ----------

function Timeline({ query, onAdd }: { query: any; onAdd: () => void }) {
  if (query.isLoading) return <LoadingBlock rows={5} height={44} />;
  if (query.error) return <ErrorBlock error={query.error} onRetry={query.refetch} />;
  const activities = query.data.activities ?? [];
  if (activities.length === 0) {
    return <EmptyState icon="history" title="Nothing recorded yet" message="Log the first call or note so the history starts here." action={<Button size="sm" onClick={onAdd}>Add a note</Button>} />;
  }
  return (
    <div className="timeline">
      {activities.map((activity: any) => (
        <div key={activity.id} className="tl-item">
          <span className={`tl-dot ${activity.direction === 'inbound' ? 'inbound' : activity.direction === 'outbound' ? 'outbound' : ''} ${activity.meta?.status === 'blocked' || activity.meta?.status === 'failed' ? 'alert' : ''}`}>
            <Icon name={activityIcon(activity.type)} size={11} />
          </span>
          <div className="tl-body">
            <div className="row gap-4 wrap">
              <span className="strong">{activity.title}</span>
              {activity.outcome && <Badge outline>{label(activity.outcome)}</Badge>}
            </div>
            <div className="tl-meta">
              {dateTime(activity.occurred_at)} · {relative(activity.occurred_at)}
              {activity.user_name ? ` · ${activity.user_name}` : ' · automation'}
              {activity.duration_sec ? ` · ${Math.round(activity.duration_sec / 60)} min` : ''}
            </div>
            {activity.body && <div className="tl-text">{activity.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function activityIcon(type: string): IconName {
  return ({
    created: 'plus', note: 'note', call: 'phone', email: 'mail', whatsapp: 'whatsapp', sms: 'mail',
    meeting: 'calendar', status_change: 'check', stage_change: 'pipeline', quote: 'quote',
    task: 'tasks', appointment: 'calendar', survey: 'survey', document: 'doc',
    automation: 'automation', score: 'target', assignment: 'user', system: 'settings',
  } as Record<string, IconName>)[type] ?? 'dot';
}

function TaskList({ tasks, onRefresh, onAdd }: { tasks: any[]; onRefresh: () => void; onAdd: () => void }) {
  const toast = useToast();
  if (tasks.length === 0) {
    return <EmptyState icon="tasks" title="No follow-ups" message="Schedule the next step so this lead cannot be forgotten." action={<Button size="sm" variant="primary" onClick={onAdd}>Schedule a follow-up</Button>} />;
  }
  return (
    <div className="col gap-4">
      <div className="row end"><Button size="sm" icon="plus" onClick={onAdd}>Add follow-up</Button></div>
      {tasks.map((task) => (
        <div key={task.id} className="row gap-6 top" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
          <span title={PRIORITY_META[task.priority]?.label}>{PRIORITY_META[task.priority]?.mark}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className={task.status === 'done' ? 'muted' : 'strong'} style={{ textDecoration: task.status !== 'open' ? 'line-through' : 'none' }}>
              {task.title}
            </div>
            <div className="tiny dim">
              {task.due_at ? `Due ${dateTime(task.due_at)} (${relative(task.due_at)})` : 'No due date'}
              {task.assignee_first_name ? ` · ${task.assignee_first_name}` : ''}
              {task.source !== 'manual' ? ` · created by ${task.source}` : ''}
            </div>
            {task.outcome_note && <div className="small muted" style={{ marginTop: 2 }}>{task.outcome_note}</div>}
          </div>
          {task.status === 'open' ? (
            <Button
              size="sm"
              onClick={async () => { await post(`/tasks/${task.id}/complete`, {}); onRefresh(); toast.success('Completed.'); }}
            >
              Complete
            </Button>
          ) : (
            <Badge tone={task.status === 'done' ? 'good' : ''}>{label(task.status)}</Badge>
          )}
        </div>
      ))}
    </div>
  );
}

function QuoteList({ quotations, currency, leadId }: { quotations: any[]; currency: string; leadId: string }) {
  const navigate = useNavigate();
  if (quotations.length === 0) {
    return (
      <EmptyState
        icon="quote" title="No quotation yet"
        message="Build one from your price list — the follow-up sequence starts as soon as it is sent."
        action={<Button size="sm" variant="primary" onClick={() => navigate(`/app/quotations?new=1&lead_id=${leadId}`)}>Create a quotation</Button>}
      />
    );
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Number</th><th>Title</th><th>Status</th><th className="num">Total</th><th>Sent</th><th>Valid until</th></tr></thead>
        <tbody>
          {quotations.map((quote) => (
            <tr key={quote.id} onClick={() => navigate(`/app/quotations/${quote.id}`)}>
              <td className="mono">{quote.number}</td>
              <td className="truncate" style={{ maxWidth: 220 }}>{quote.title}</td>
              <td><Badge tone={quoteTone(quote.status)}>{label(quote.status)}</Badge></td>
              <td className="num strong">{money(quote.total, quote.currency ?? currency)}</td>
              <td className="small dim">{quote.sent_at ? relative(quote.sent_at) : '—'}</td>
              <td className="small dim">{quote.valid_until ? date(quote.valid_until) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function quoteTone(status: string): string {
  if (status === 'accepted') return 'good';
  if (status === 'rejected' || status === 'expired') return 'danger';
  if (status === 'sent' || status === 'viewed' || status === 'awaiting_response') return 'warm';
  return '';
}

function SurveyList({
  surveys, appointments, leadId, onAdd, onRefresh,
}: {
  surveys: any[]; appointments: any[]; leadId: string; onAdd: () => void; onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const { can } = useSession();
  const [closing, setClosing] = useState<any | null>(null);
  if (surveys.length === 0 && appointments.length === 0) {
    return <EmptyState icon="survey" title="No site visit booked" message="A technical survey is the fastest way to turn an enquiry into an accurate quotation." action={<Button size="sm" variant="primary" onClick={onAdd}>Book a site survey</Button>} />;
  }
  return (
    <div className="col gap-6">
      <div className="row end"><Button size="sm" icon="plus" onClick={onAdd}>Book a visit</Button></div>
      {surveys.map((survey) => (
        // A card, not a button: it carries its own actions, and a button inside a
        // button is invalid HTML.
        <div key={survey.id} className="card" style={{ padding: 12 }}>
          <button
            className="row between wrap gap-4"
            style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', font: 'inherit', color: 'inherit', cursor: 'pointer', padding: 0 }}
            onClick={() => navigate(`/app/surveys/${survey.id}`)}
          >
            <div>
              <div className="strong">Site survey — {label(survey.project_type)}</div>
              <div className="tiny dim">
                {survey.scheduled_at ? dateTime(survey.scheduled_at) : 'not scheduled'}
                {survey.tech_first_name ? ` · ${survey.tech_first_name} ${survey.tech_last_name}` : ' · no technician'}
              </div>
            </div>
            <Badge tone={survey.status === 'completed' ? 'good' : survey.status === 'cancelled' ? 'danger' : 'cold'}>{label(survey.status)}</Badge>
          </button>
          {survey.recommended_system && <div className="small mt-2"><strong>Recommended:</strong> {survey.recommended_system}</div>}
          {survey.technical_notes && <div className="small muted mt-2" style={{ whiteSpace: 'pre-wrap' }}>{survey.technical_notes}</div>}
          {survey.blockers && <div className="banner warn mt-2"><Icon name="alert" size={14} /><span>{survey.blockers}</span></div>}
          {survey.status === 'completed' && can('quotes:write') && (
            <div className="row gap-4 mt-4 wrap">
              <Button
                size="sm" variant="primary" icon="quote"
                onClick={() => navigate(`/app/quotations?new=1&lead_id=${leadId}&survey_id=${survey.id}`)}
              >
                Create quotation
              </Button>
              <span className="tiny dim">Pre-filled from this survey — you review it before saving.</span>
            </div>
          )}
        </div>
      ))}
      {appointments.filter((a) => !surveys.some((s) => s.appointment_id === a.id)).map((appt) => (
        <div key={appt.id} className="card" style={{ padding: 12 }}>
          <div className="row between wrap gap-4">
            <div style={{ minWidth: 0 }}>
              <div className="strong">{appt.title}</div>
              <div className="tiny dim">
                {dateTime(appt.starts_at)}{appt.location ? ` · ${appt.location}` : ''}
                {appt.tech_first_name ? ` · ${appt.tech_first_name} ${appt.tech_last_name}` : ''}
              </div>
              {appt.outcome_note && <div className="small muted mt-2">{appt.outcome_note}</div>}
            </div>
            <div className="row gap-4">
              <Badge tone={appt.status === 'completed' ? 'good' : appt.status === 'cancelled' ? 'danger' : appt.status === 'no_show' ? 'warm' : 'cold'}>
                {appt.status === 'no_show' ? 'Missed' : label(appt.status)}
              </Badge>
              {appt.status === 'scheduled' && can('appointments:write') && (
                <Button size="sm" onClick={() => setClosing(appt)}>Update</Button>
              )}
            </div>
          </div>
          {appt.status === 'scheduled' && isOverdue(appt.starts_at) && (
            <div className="banner warn mt-2">
              <Icon name="alert" size={14} />
              <span>This visit has passed and has not been closed off.</span>
            </div>
          )}
        </div>
      ))}
      {closing && (
        <AppointmentOutcome
          appointment={closing}
          onClose={() => setClosing(null)}
          onSaved={onRefresh}
        />
      )}
    </div>
  );
}

function FileList({ documents, onAdd }: { documents: any[]; onAdd: () => void }) {
  if (documents.length === 0) {
    return <EmptyState icon="doc" title="No files" message="Roof photos, electrical panel pictures, bills and signed documents live here." action={<Button size="sm" onClick={onAdd}>Upload a file</Button>} />;
  }
  return (
    <div className="col gap-4">
      <div className="row end"><Button size="sm" icon="upload" onClick={onAdd}>Upload</Button></div>
      <div className="grid auto">
        {documents.map((doc) => (
          <a key={doc.id} className="card" href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer" style={{ padding: 10, textDecoration: 'none', color: 'inherit' }}>
            <div className="row gap-4">
              <Icon name={doc.kind === 'photo' ? 'camera' : 'doc'} size={16} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate small strong">{doc.filename}</div>
                <div className="tiny dim">{Math.round(doc.size_bytes / 1024)} KB · {relative(doc.created_at)}</div>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

const STOP_REASON: Record<string, string> = {
  contacted: 'the salesperson made contact',
  customer_replied: 'the customer replied',
  appointment_booked: 'a visit was booked',
  quote_responded: 'the customer answered the quotation',
  won: 'the deal was won',
  lost: 'the lead was lost',
  paused: 'automation was paused on this lead',
  opted_out: 'the contact opted out',
  stopped_manually: 'stopped by hand',
  appointment_cancelled: 'the appointment was cancelled',
  rule_disabled: 'the rule was switched off',
};

function AutomationList({ runs, lead, onRefresh }: { runs: any[]; lead: any; onRefresh: () => void }) {
  const toast = useToast();
  const { can } = useSession();

  const command = async (runId: string, what: 'pause' | 'resume' | 'stop') => {
    try {
      await post(`/leads/${lead.id}/automation/${runId}/${what}`);
      onRefresh();
      toast.success(
        what === 'stop' ? 'Sequence stopped.' : what === 'pause' ? 'Sequence paused.' : 'Sequence resumed.',
        'The other sequences on this lead are unaffected.',
      );
    } catch (err) { toast.error(err); }
  };
  return (
    <div className="col gap-6">
      <div className="banner">
        <Icon name="automation" size={15} />
        <div className="grow">
          <strong>{lead.automation_paused ? 'Automation is paused for this lead.' : 'Automation is running for this lead.'}</strong>
          <div className="small">Pausing holds every sequence where it is; resuming carries on from the same step. Customer-facing messages are never sent without a connected channel.</div>
        </div>
        {can('leads:write') && (
          <Button
            size="sm"
            onClick={async () => {
              await post(`/leads/${lead.id}/automation`, { paused: !lead.automation_paused });
              onRefresh();
              toast.success(lead.automation_paused ? 'Automation resumed.' : 'Automation paused.');
            }}
          >
            {lead.automation_paused ? 'Resume' : 'Pause'}
          </Button>
        )}
      </div>
      {lead.messaging_opt_out && (
        <div className="banner warn">
          <Icon name="alert" size={15} />
          <span>This contact has opted out of automatic messages, so no sequence will message them.</span>
        </div>
      )}
      {runs.length === 0 ? (
        <EmptyState icon="automation" title="No automation has run" message="Sequences start when a lead is created, becomes hot, or a quotation is sent." />
      ) : runs.map((run) => {
        const lines: string[] = (run.log ?? []).flatMap((entry: any) => entry.entries ?? []);
        // A line that says something was not sent is the one worth seeing.
        const failed = lines.filter((line) => /not sent|failed|could not/i.test(line));
        return (
          <div key={run.id} className="card" style={{ padding: 12 }}>
            <div className="row between wrap gap-4">
              <div style={{ minWidth: 0 }}>
                <div className="strong">{run.rule_name}</div>
                <div className="tiny dim">
                  Started {relative(run.started_at)} · {run.step_index} step{run.step_index === 1 ? '' : 's'} done
                  {run.stopped_reason ? ` · stopped: ${STOP_REASON[run.stopped_reason] ?? run.stopped_reason.replace(/_/g, ' ')}` : ''}
                </div>
                {run.status === 'active' && !run.paused_at && run.next_run_at && (
                  <div className="small" style={{ marginTop: 2, color: 'var(--accent-ink)' }}>
                    → Next step {relative(run.next_run_at)}
                  </div>
                )}
                {run.paused_at && (
                  <div className="small" style={{ marginTop: 2, color: 'var(--warm)' }}>
                    Paused {relative(run.paused_at)} — resuming gives back the time it had left.
                  </div>
                )}
              </div>
              <div className="row gap-4 wrap">
                <Badge tone={
                  run.paused_at ? 'warm'
                    : run.status === 'active' ? 'accent'
                      : run.status === 'failed' ? 'danger'
                        : run.status === 'completed' ? 'good' : ''
                }>
                  {run.paused_at ? 'Paused' : label(run.status)}
                </Badge>
                {run.status === 'active' && can('leads:write') && (
                  <>
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => command(run.id, run.paused_at ? 'resume' : 'pause')}
                    >
                      {run.paused_at ? 'Resume' : 'Pause'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => command(run.id, 'stop')}>Stop</Button>
                  </>
                )}
              </div>
            </div>
            {failed.length > 0 && (
              <div className="banner warn" style={{ marginTop: 8 }}>
                <Icon name="alert" size={14} />
                <span>{failed[failed.length - 1]}</span>
              </div>
            )}
            {lines.length > 0 && (
              <ul className="small muted" style={{ margin: '8px 0 0', paddingLeft: 16 }}>
                {lines.map((line: string, index: number) => <li key={index}>{line}</li>)}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- dialogs ----------

function ActivityDialog({ leadId, type, onClose, onSaved }: { leadId: string; type: string; onClose: () => void; onSaved: () => void }) {
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const save = async () => {
    setSaving(true);
    try {
      await post(`/leads/${leadId}/activities`, { type, direction: 'internal', body });
      toast.success('Note added.');
      onSaved(); onClose();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Modal
      title="Add a note" onClose={onClose} width="narrow"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!body.trim()} onClick={save}>Save note</Button></>}
    >
      <textarea autoFocus rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened? What did the customer say?" />
    </Modal>
  );
}

function CallDialog({ lead, onClose, onSaved }: { lead: any; onClose: () => void; onSaved: () => void }) {
  const [outcome, setOutcome] = useState('answered');
  const [body, setBody] = useState('');
  const [minutes, setMinutes] = useState('');
  const [saving, setSaving] = useState(false);
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const toast = useToast();

  const { data: dial } = useQuery({
    queryKey: ['call', lead.id],
    queryFn: () => post('/messages/call', { lead_id: lead.id }),
    retry: false,
  });

  const save = async () => {
    setSaving(true);
    try {
      await post(`/leads/${lead.id}/activities`, {
        type: 'call', direction, outcome, body,
        duration_sec: minutes ? Number(minutes) * 60 : undefined,
      });
      toast.success('Call logged.');
      onSaved(); onClose();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Call ${lead.first_name}`} subtitle={lead.phone ?? undefined} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Log the call</Button></>}
    >
      <div className="col gap-6">
        <div className="row gap-4 wrap">
          <a className="btn primary" href={dial?.tel ?? `tel:${lead.phone}`}><Icon name="phone" size={15} />Dial {lead.phone}</a>
          {dial?.whatsapp && <a className="btn" href={dial.whatsapp} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={15} />WhatsApp</a>}
        </div>
        {dial?.note && <div className="banner"><Icon name="dot" size={14} /><span>{dial.note}</span></div>}
        <div className="grid c3">
          <div className="field">
            <label>Direction</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
              <option value="outbound">We called them</option>
              <option value="inbound">They called us</option>
            </select>
          </div>
          <div className="field">
            <label>Outcome</label>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="answered">Answered</option>
              <option value="no_answer">No answer</option>
              <option value="voicemail">Voicemail</option>
              <option value="callback">Call back later</option>
              <option value="interested">Interested</option>
              <option value="not_interested">Not interested</option>
            </select>
          </div>
          <div className="field">
            <label>Duration (min)</label>
            <input type="number" min="0" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>What was said</label>
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Key points, objections, what you agreed." />
        </div>
      </div>
    </Modal>
  );
}

function TaskDialog({ leadId, defaultAssignee, onClose, onSaved }: { leadId: string; defaultAssignee?: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('follow_up');
  const [priority, setPriority] = useState('normal');
  const [dueAt, setDueAt] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
    return toInputDateTime(d.toISOString());
  });
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  // One key per open dialog: a double-click cannot create two tasks, while an
  // identical follow-up scheduled again later still can be.
  const requestId = useRef(newRequestId());

  const save = async () => {
    setSaving(true);
    try {
      await post('/tasks', {
        lead_id: leadId, title, type, priority,
        due_at: fromInputDateTime(dueAt), description: description || undefined,
        assignee_id: defaultAssignee,
      }, { idempotencyKey: requestId.current });
      toast.success('Follow-up scheduled.');
      onSaved(); onClose();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Modal
      title="Schedule the next action" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!title.trim()} onClick={save}>Schedule</Button></>}
    >
      <div className="col gap-6">
        <div className="field">
          <label>What needs to happen?</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call back about the proposal" />
        </div>
        <div className="grid c3">
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="follow_up">Follow-up</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="meeting">Meeting</option>
              <option value="quote">Quotation</option>
              <option value="survey">Site survey</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="field">
            <label>Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="urgent">🔴 Urgent</option>
              <option value="high">🟠 High</option>
              <option value="normal">🟡 Normal</option>
              <option value="low">🔵 Low</option>
            </select>
          </div>
          <div className="field">
            <label>Due</label>
            <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Notes (optional)</label>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function RescheduleDialog({ taskId, onClose, onSaved }: { taskId: string; onClose: () => void; onSaved: () => void }) {
  const [dueAt, setDueAt] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(10, 0, 0, 0);
    return toInputDateTime(d.toISOString());
  });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const quick = (days: number) => {
    const d = new Date(); d.setDate(d.getDate() + days); d.setHours(10, 0, 0, 0);
    setDueAt(toInputDateTime(d.toISOString()));
  };

  return (
    <Modal
      title="Reschedule" onClose={onClose} width="narrow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await post(`/tasks/${taskId}/reschedule`, { due_at: fromInputDateTime(dueAt) });
                toast.success('Rescheduled.');
                onSaved(); onClose();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Reschedule
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="chips">
          <button className="chip" onClick={() => quick(0)}>Today</button>
          <button className="chip" onClick={() => quick(1)}>Tomorrow</button>
          <button className="chip" onClick={() => quick(3)}>In 3 days</button>
          <button className="chip" onClick={() => quick(7)}>Next week</button>
          <button className="chip" onClick={() => quick(30)}>In a month</button>
        </div>
        <div className="field">
          <label>New date and time</label>
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function UploadDialog({ leadId, onClose, onSaved }: { leadId: string; onClose: () => void; onSaved: () => void }) {
  const [files, setFiles] = useState<FileList | null>(null);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  const upload = async () => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const data = new FormData();
      Array.from(files).forEach((file) => data.append('files', file));
      data.append('lead_id', leadId);
      await post('/documents', data);
      toast.success(`${files.length} file(s) uploaded.`);
      onSaved(); onClose();
    } catch (err) { toast.error(err); } finally { setUploading(false); }
  };

  return (
    <Modal
      title="Upload files" subtitle="Photos, bills, plans, signed documents." onClose={onClose} width="narrow"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={uploading} disabled={!files?.length} onClick={upload}>Upload</Button></>}
    >
      <input
        type="file" multiple onChange={(e) => setFiles(e.target.files)}
        accept="image/*,application/pdf,.csv,.xlsx,.docx" capture={undefined}
      />
      <p className="small muted mt-4" style={{ marginBottom: 0 }}>
        Images, PDF, CSV, Word and Excel up to 15 MB each. On a phone you can take a photo directly.
      </p>
    </Modal>
  );
}

function StageDialog({ lead, onClose, onSaved }: { lead: any; onClose: () => void; onSaved: () => void }) {
  const { data } = useQuery({ queryKey: ['stages'], queryFn: () => get('/settings/stages'), staleTime: 300_000 });
  const [saving, setSaving] = useState<string | null>(null);
  const toast = useToast();
  const stages = (data?.stages ?? []).filter((s: any) => s.is_active && s.type !== 'lost');

  return (
    <Modal title="Move to a stage" onClose={onClose} width="narrow">
      <div className="col gap-2">
        {stages.map((stage: any) => (
          <button
            key={stage.id}
            className={`btn ${stage.id === lead.stage_id ? 'primary' : ''}`}
            style={{ justifyContent: 'flex-start' }}
            disabled={saving !== null}
            onClick={async () => {
              if (stage.id === lead.stage_id) return onClose();
              setSaving(stage.id);
              try {
                await post(`/leads/${lead.id}/stage`, { stage_id: stage.id });
                toast.success(`Moved to ${stage.name}.`);
                onSaved(); onClose();
              } catch (err) { toast.error(err); } finally { setSaving(null); }
            }}
          >
            <span className="dot" style={{ color: stage.color }} />
            <span className="grow" style={{ textAlign: 'left' }}>{stage.name}</span>
            <span className="small dim">{stage.probability}%</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function AssignDialog({ lead, onClose, onSaved }: { lead: any; onClose: () => void; onSaved: () => void }) {
  const { data } = useQuery({ queryKey: ['users-light'], queryFn: () => get('/settings/users'), staleTime: 300_000 });
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const users = (data?.users ?? []).filter((u: any) => u.status === 'active' && u.role !== 'technician');

  const assign = async (ownerId: string | null) => {
    setSaving(true);
    try {
      await post(`/leads/${lead.id}/assign`, { owner_id: ownerId });
      toast.success('Lead reassigned.');
      onSaved(); onClose();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Modal title="Assign this lead" onClose={onClose} width="narrow">
      <div className="col gap-2">
        {users.map((user: any) => (
          <button
            key={user.id} className={`btn ${user.id === lead.owner_id ? 'primary' : ''}`}
            style={{ justifyContent: 'flex-start' }} disabled={saving}
            onClick={() => assign(user.id)}
          >
            <Avatar name={user.full_name} color={user.avatar_color} size="sm" />
            <span className="grow" style={{ textAlign: 'left' }}>{user.full_name}</span>
            <span className="small dim">{user.open_leads} open</span>
          </button>
        ))}
        <button className="btn" style={{ justifyContent: 'flex-start' }} disabled={saving} onClick={() => assign(null)}>
          Leave unassigned
        </button>
      </div>
    </Modal>
  );
}

function WonDialog({ lead, currency, onClose, onSaved }: { lead: any; currency: string; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(String(Math.round(lead.estimated_value || 0)));
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  return (
    <Modal
      title="Mark this deal as won" onClose={onClose} width="narrow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await post(`/leads/${lead.id}/won`, { contract_value: Number(value) || undefined });
                toast.success('Deal won. Revenue recorded and the installation handover has started.');
                onSaved(); onClose();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Mark as won
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="field">
          <label>Contract value ({currency})</label>
          <input type="number" min="0" step="100" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <span className="hint">Defaults to the accepted quotation total if there is one.</span>
        </div>
        <div className="banner info">
          <Icon name="check" size={15} />
          <span>
            The customer record is created, active sales sequences stop and an installation handover task
            is opened for your team.
          </span>
        </div>
      </div>
    </Modal>
  );
}

function LostDialog({ lead, onClose, onSaved }: { lead: any; onClose: () => void; onSaved: () => void }) {
  const { data } = useQuery({ queryKey: ['lost-reasons'], queryFn: () => get('/settings/lost-reasons'), staleTime: 300_000 });
  const [reasonId, setReasonId] = useState('');
  const [notes, setNotes] = useState('');
  const [recoveryDate, setRecoveryDate] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const reasons = data?.lost_reasons ?? [];
  const reason = reasons.find((r: any) => r.id === reasonId);

  const quickRecovery = (months: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    setRecoveryDate(d.toISOString().slice(0, 10));
  };

  return (
    <Modal
      title="Mark as lost" subtitle="Recording why lets you see what is really costing you deals." onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger" loading={saving} disabled={!reasonId}
            onClick={async () => {
              setSaving(true);
              try {
                await post(`/leads/${lead.id}/lost`, {
                  lost_reason_id: reasonId,
                  lost_notes: notes || undefined,
                  recovery_date: recoveryDate ? new Date(recoveryDate).toISOString() : undefined,
                });
                toast.success(recoveryDate ? 'Marked lost — a recovery task is scheduled.' : 'Marked lost.');
                onSaved(); onClose();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Mark as lost
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="field">
          <label>Why was it lost?</label>
          <div className="chips">
            {reasons.map((r: any) => (
              <button key={r.id} type="button" className={`chip ${reasonId === r.id ? 'on' : ''}`} onClick={() => setReasonId(r.id)}>
                {r.name}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Details</label>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Which competitor? How far apart on price? What changed?" />
        </div>
        {reason?.recoverable ? (
          <div className="field">
            <label>Contact again on</label>
            <div className="chips mb-2">
              <button type="button" className="chip" onClick={() => quickRecovery(3)}>In 3 months</button>
              <button type="button" className="chip" onClick={() => quickRecovery(6)}>In 6 months</button>
              <button type="button" className="chip" onClick={() => quickRecovery(12)}>In a year</button>
            </div>
            <input type="date" value={recoveryDate} onChange={(e) => setRecoveryDate(e.target.value)} />
            <span className="hint">A recovery task is created for that date automatically. Leave blank to close it for good.</span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
