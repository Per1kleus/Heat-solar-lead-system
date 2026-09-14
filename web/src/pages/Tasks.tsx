import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, newRequestId, post } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock, Modal,
  SearchInput, Tabs, useDebounced, useToast,
} from '../components/ui';
import { money, dateTime, relative, isOverdue, PRIORITY_META, label, toInputDateTime, fromInputDateTime } from '../lib/format';

export default function Tasks() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { organization, can, user } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const bucket = params.get('bucket') ?? 'open';
  const assignee = params.get('assignee_id') ?? '';
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [showNew, setShowNew] = useState(false);
  const [completing, setCompleting] = useState<any>(null);

  const queryString = new URLSearchParams({
    ...(bucket !== 'open' && bucket !== 'done' ? { bucket } : {}),
    ...(bucket === 'done' ? { status: 'done' } : {}),
    ...(assignee ? { assignee_id: assignee } : {}),
    ...(debounced.trim() ? { search: debounced.trim() } : {}),
    limit: '150',
  }).toString();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tasks', queryString],
    queryFn: () => get(`/tasks?${queryString}`),
    placeholderData: (prev) => prev,
  });

  const { data: users } = useQuery({
    queryKey: ['users-light'], queryFn: () => get('/settings/users'),
    enabled: can('tasks:read:all'), staleTime: 300_000,
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const complete = async (task: any, note?: string) => {
    try {
      await post(`/tasks/${task.id}/complete`, { outcome_note: note });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      toast.success('Follow-up completed.');
    } catch (err) { toast.error(err); }
  };

  const tasks = data?.tasks ?? [];
  const counts = data?.counts ?? { overdue: 0, today: 0 };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Follow-ups</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Everything you owe a customer, in the order it is due.
          </p>
        </div>
        <div className="row gap-4">
          <Button icon="plus" variant="primary" onClick={() => setShowNew(true)}>New task</Button>
        </div>
      </div>

      <Card padded={false}>
        <div style={{ padding: '0 14px' }}>
          <Tabs
            active={bucket} onChange={(key) => setParam('bucket', key)}
            tabs={[
              { key: 'overdue', label: 'Overdue', count: counts.overdue },
              { key: 'today', label: 'Today', count: counts.today },
              { key: 'week', label: 'This week' },
              { key: 'open', label: 'All open' },
              { key: 'done', label: 'Completed' },
            ]}
          />
        </div>

        <div className="card-body tight row gap-4 wrap">
          <SearchInput value={search} onChange={setSearch} placeholder="Search tasks or customers…" />
          {can('tasks:read:all') && (
            <select value={assignee} onChange={(e) => setParam('assignee_id', e.target.value)} style={{ width: 'auto' }} aria-label="Assignee">
              <option value="">Everyone</option>
              <option value={user?.id}>Just me</option>
              <option value="unassigned">Unassigned</option>
              {(users?.users ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
        </div>

        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={6} height={40} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={bucket === 'overdue' ? 'check' : 'tasks'}
            title={bucket === 'overdue' ? 'Nothing overdue' : bucket === 'done' ? 'Nothing completed yet' : 'No follow-ups here'}
            message={bucket === 'overdue'
              ? 'Every follow-up is on schedule. That is exactly how it should look.'
              : 'Schedule the next step on a lead and it appears here.'}
          />
        ) : (
          <div>
            {tasks.map((task: any) => {
              const overdue = task.status === 'open' && isOverdue(task.due_at);
              return (
                <div key={task.id} className="attention-item" style={{ cursor: 'default' }}>
                  {task.status === 'open' && (
                    <button
                      className="btn sm icon" title="Complete"
                      onClick={() => (task.type === 'call' || task.type === 'follow_up' ? setCompleting(task) : complete(task))}
                      aria-label={`Complete ${task.title}`}
                    >
                      <Icon name="check" size={14} />
                    </button>
                  )}
                  <span title={PRIORITY_META[task.priority]?.label} aria-hidden="true">{PRIORITY_META[task.priority]?.mark}</span>
                  <button
                    className="grow"
                    style={{ minWidth: 0, textAlign: 'left', border: 0, background: 'none', font: 'inherit', cursor: task.lead_id ? 'pointer' : 'default', color: 'inherit' }}
                    onClick={() => task.lead_id && navigate(`/app/leads/${task.lead_id}`)}
                  >
                    <div className="truncate strong" style={{ textDecoration: task.status === 'done' ? 'line-through' : 'none', opacity: task.status === 'done' ? .6 : 1 }}>
                      {task.title}
                    </div>
                    <div className="tiny dim truncate">
                      {task.lead_first_name ? `${task.lead_first_name} ${task.lead_last_name} · ` : ''}
                      {task.due_at ? `${dateTime(task.due_at)} (${relative(task.due_at)})` : 'no due date'}
                      {task.source !== 'manual' ? ` · from ${task.source}` : ''}
                    </div>
                  </button>
                  {task.lead_value ? <span className="small strong nowrap hide-mobile">{money(task.lead_value, currency)}</span> : null}
                  {task.lead_temperature && <span className="hide-mobile"><Badge tone={task.lead_temperature}>{task.lead_temperature}</Badge></span>}
                  {overdue && <Badge tone="danger">overdue</Badge>}
                  {task.assignee_first_name && (
                    <span className="hide-mobile"><Avatar name={`${task.assignee_first_name} ${task.assignee_last_name}`} color={task.assignee_color} size="sm" /></span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {showNew && <NewTaskDialog onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refetch(); }} />}
      {completing && (
        <CompleteDialog
          task={completing}
          onClose={() => setCompleting(null)}
          onConfirm={async (note, followUp) => {
            await complete(completing, note);
            if (followUp) {
              const due = new Date();
              due.setDate(due.getDate() + followUp);
              due.setHours(10, 0, 0, 0);
              await post('/tasks', {
                lead_id: completing.lead_id,
                title: `Follow up: ${completing.lead_first_name ?? 'customer'}`,
                type: 'follow_up', priority: 'normal', due_at: due.toISOString(),
              });
              queryClient.invalidateQueries({ queryKey: ['tasks'] });
              toast.success(`Next follow-up scheduled in ${followUp} day${followUp === 1 ? '' : 's'}.`);
            }
            setCompleting(null);
          }}
        />
      )}
    </div>
  );
}

function CompleteDialog({
  task, onClose, onConfirm,
}: { task: any; onClose: () => void; onConfirm: (note: string, followUpDays: number | null) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal
      title="Complete this follow-up" subtitle={task.title} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving}
            onClick={async () => { setSaving(true); try { await onConfirm(note, followUp); } finally { setSaving(false); } }}
          >
            Complete
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="field">
          <label>What happened?</label>
          <textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, but it keeps the timeline useful." />
        </div>
        {task.lead_id && (
          <div className="field">
            <label>Schedule the next step</label>
            <div className="chips">
              {[[null, 'Not yet'], [1, 'Tomorrow'], [3, 'In 3 days'], [7, 'Next week'], [30, 'In a month']].map(([days, text]) => (
                <button
                  key={String(text)} type="button"
                  className={`chip ${followUp === days ? 'on' : ''}`}
                  onClick={() => setFollowUp(days as number | null)}
                >
                  {text as string}
                </button>
              ))}
            </div>
            <span className="hint">Leaving a lead with no next action is what loses deals.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function NewTaskDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [leadId, setLeadId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [type, setType] = useState('follow_up');
  const [dueAt, setDueAt] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
    return toInputDateTime(d.toISOString());
  });
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const { data: leads } = useQuery({
    queryKey: ['task-lead-search', debounced],
    queryFn: () => get(`/leads?search=${encodeURIComponent(debounced)}&limit=10`),
    enabled: debounced.trim().length >= 2,
  });

  // One key per open dialog — see newRequestId.
  const requestId = useRef(newRequestId());

  return (
    <Modal
      title="New task" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving} disabled={!title.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await post('/tasks', {
                  title, type, priority, due_at: fromInputDateTime(dueAt),
                  lead_id: leadId || undefined,
                }, { idempotencyKey: requestId.current });
                toast.success('Task created.');
                onSaved();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="field">
          <label>Task</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call back about the battery option" />
        </div>
        <div className="field">
          <label>Link to a lead (optional)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or phone…" />
          {(leads?.leads ?? []).length > 0 && (
            <div className="chips mt-2">
              {leads.leads.map((lead: any) => (
                <button
                  key={lead.id} type="button"
                  className={`chip ${leadId === lead.id ? 'on' : ''}`}
                  onClick={() => { setLeadId(lead.id); setSearch(lead.full_name); }}
                >
                  {lead.full_name} · {lead.city ?? '—'}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid c3">
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="follow_up">Follow-up</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="quote">Quotation</option>
              <option value="survey">Site survey</option>
              <option value="admin">Admin</option>
              <option value="post_sale">Post-sale</option>
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
      </div>
    </Modal>
  );
}
