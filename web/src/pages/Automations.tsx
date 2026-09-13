import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, del } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBlock, Field, Icon, LoadingBlock, Modal, useToast,
} from '../components/ui';
import { relative, label } from '../lib/format';

export default function Automations() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can, hasFeature } = useSession();
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);
  const [inspecting, setInspecting] = useState<any>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['automations'],
    queryFn: () => get('/automations'),
  });

  const toggle = async (rule: any) => {
    try {
      await patch(`/automations/${rule.id}`, { is_active: !rule.is_active });
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(rule.is_active ? `“${rule.name}” switched off.` : `“${rule.name}” switched on.`);
    } catch (err) { toast.error(err); }
  };

  if (isLoading) return <div className="page"><LoadingBlock rows={5} height={70} /></div>;
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const rules = data.rules ?? [];
  const systemRules = rules.filter((r: any) => r.is_system);
  const customRules = rules.filter((r: any) => !r.is_system);

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="page-head">
        <div>
          <h1>Automation</h1>
          <p className="muted small" style={{ margin: 0 }}>
            The rules that make it hard to forget a lead. Each one shows exactly what it does and what stops it.
          </p>
        </div>
        {can('automation:write') && (
          <Button
            icon="plus" variant="primary" onClick={() => setCreating(true)}
            title={hasFeature('automation_advanced') ? undefined : 'Custom automation is available on Growth and Pro'}
          >
            New automation
          </Button>
        )}
      </div>

      <div className="banner mb-6">
        <Icon name="shield" size={16} />
        <span>
          Customer-facing messages are only ever sent through a channel you have connected, and marketing
          messages require recorded consent. Everything else is internal: tasks, notifications and stage changes.
        </span>
      </div>

      <Card title="Built-in rules" subtitle="The eight defaults every installer needs. Switch any of them off." padded={false}>
        {systemRules.map((rule: any) => (
          <RuleRow
            key={rule.id} rule={rule} triggers={data.triggers}
            canWrite={can('automation:write')}
            onToggle={() => toggle(rule)}
            onInspect={() => setInspecting(rule)}
            onEdit={() => setEditing(rule)}
          />
        ))}
      </Card>

      <Card title="Your automations" subtitle="Rules you have built yourself" padded={false} >
        {customRules.length === 0 ? (
          <EmptyState
            icon="automation" title="No custom automations yet"
            message="Build one for anything your team keeps forgetting — a reminder when a big lead goes quiet, a task when a survey is booked."
            action={can('automation:write') ? <Button size="sm" onClick={() => setCreating(true)}>New automation</Button> : undefined}
          />
        ) : customRules.map((rule: any) => (
          <RuleRow
            key={rule.id} rule={rule} triggers={data.triggers}
            canWrite={can('automation:write')}
            onToggle={() => toggle(rule)}
            onInspect={() => setInspecting(rule)}
            onEdit={() => setEditing(rule)}
            onDelete={() => setDeleting(rule)}
          />
        ))}
      </Card>

      {(creating || editing) && (
        <RuleEditor
          rule={editing} meta={data}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            setCreating(false); setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['automations'] });
            toast.success('Automation saved.');
          }}
        />
      )}
      {inspecting && <RuleInspector rule={inspecting} onClose={() => setInspecting(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`} tone="danger" confirmLabel="Delete"
          message="Active runs stop immediately. Built-in rules are switched off rather than deleted."
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await del(`/automations/${deleting.id}`);
              setDeleting(null);
              queryClient.invalidateQueries({ queryKey: ['automations'] });
              toast.success('Automation removed.');
            } catch (err) { toast.error(err); }
          }}
        />
      )}
    </div>
  );
}

function RuleRow({
  rule, triggers, canWrite, onToggle, onInspect, onEdit, onDelete,
}: {
  rule: any; triggers: any[]; canWrite: boolean;
  onToggle: () => void; onInspect: () => void; onEdit: () => void; onDelete?: () => void;
}) {
  const trigger = triggers.find((t: any) => t.key === rule.trigger_type);
  return (
    <div className="attention-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <label className="row gap-4" style={{ cursor: canWrite ? 'pointer' : 'default', paddingTop: 2 }}>
        <input type="checkbox" checked={rule.is_active} onChange={onToggle} disabled={!canWrite} aria-label={`Enable ${rule.name}`} />
      </label>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row gap-4 wrap">
          <span className="strong">{rule.name}</span>
          {!rule.is_active && <Badge>off</Badge>}
          {rule.active_runs > 0 && <Badge tone="accent">{rule.active_runs} running</Badge>}
        </div>
        <div className="small muted">{rule.description}</div>
        <div className="tiny dim mt-2">
          <strong>When</strong> {trigger?.label ?? rule.trigger_type}
          {rule.steps.length > 1 ? ` · ${rule.steps.length} steps` : ''}
          {rule.stop_on.length > 0 ? ` · stops on ${rule.stop_on.join(', ').replace(/_/g, ' ')}` : ''}
          {rule.run_count > 0 ? ` · ran ${rule.run_count} times, last ${relative(rule.last_run_at)}` : ' · never run'}
        </div>
      </div>
      <div className="row gap-4">
        <Button size="sm" onClick={onInspect}>Details</Button>
        {canWrite && <Button size="sm" icon="edit" onClick={onEdit} aria-label="Edit" />}
        {canWrite && onDelete && <Button size="sm" variant="ghost" icon="trash" onClick={onDelete} aria-label="Delete" />}
      </div>
    </div>
  );
}

function RuleInspector({ rule, onClose }: { rule: any; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['automation-runs', rule.id],
    queryFn: () => get(`/automations/${rule.id}/runs`),
  });

  return (
    <Modal title={rule.name} subtitle={rule.description ?? undefined} onClose={onClose} width="wide">
      <div className="col gap-6">
        <Card title="What it does">
          <ol style={{ margin: 0, paddingLeft: 18 }} className="col gap-4">
            {rule.steps.map((step: any, index: number) => (
              <li key={index}>
                <div className="strong small">
                  {step.delay_minutes === 0 ? 'Immediately' : `After ${humanDelay(step.delay_minutes)}`}
                </div>
                <ul className="small muted" style={{ margin: '3px 0 0', paddingLeft: 16 }}>
                  {step.actions.map((action: any, actionIndex: number) => (
                    <li key={actionIndex}>{describeAction(action)}</li>
                  ))}
                </ul>
                {step.stop_if?.length > 0 && (
                  <div className="tiny dim">Skipped if: {step.stop_if.join(', ').replace(/_/g, ' ')}</div>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Recent runs" padded={false}>
          {!data ? <div style={{ padding: 14 }}><LoadingBlock rows={3} height={34} /></div>
            : data.runs.length === 0 ? <EmptyState icon="history" title="Never run yet" />
              : (
                <div>
                  {data.runs.slice(0, 25).map((run: any) => (
                    <div key={run.id} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
                      <div className="row between gap-4">
                        <span className="small strong truncate">
                          {run.first_name ? `${run.first_name} ${run.last_name}` : run.reference ?? 'lead removed'}
                        </span>
                        <Badge tone={run.status === 'active' ? 'accent' : run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'good' : ''}>
                          {label(run.status)}
                        </Badge>
                      </div>
                      <div className="tiny dim">
                        started {relative(run.started_at)} · step {run.step_index}
                        {run.stopped_reason ? ` · stopped: ${run.stopped_reason.replace(/_/g, ' ')}` : ''}
                      </div>
                      {run.log?.length > 0 && (
                        <ul className="tiny muted" style={{ margin: '4px 0 0', paddingLeft: 15 }}>
                          {run.log.flatMap((entry: any) => entry.entries ?? []).slice(0, 4).map((line: string, i: number) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
        </Card>
      </div>
    </Modal>
  );
}

function humanDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

function describeAction(action: any): string {
  switch (action.type) {
    case 'create_task': return `Create a ${action.task_type ?? 'follow-up'} task: “${action.title}”${action.priority ? ` (${action.priority} priority)` : ''}`;
    case 'notify_owner': return `Notify the lead owner: “${action.title}”`;
    case 'notify_assignee': return `Notify the task assignee: “${action.title}”`;
    case 'notify_managers': return `Notify sales managers: “${action.title}”`;
    case 'send_template': return `Send the “${action.template_key}” ${action.channel ?? 'email'} template — only if that channel is connected`;
    case 'change_stage': return `Move the lead to the “${action.stage_key}” stage`;
    case 'add_tag': return `Tag the lead “${action.tag}”`;
    case 'schedule_recovery': return 'Create the recovery task for the date recorded on the lost lead';
    case 'stop_sales_automations': return 'Stop active sales sequences and create the customer record';
    default: return action.type;
  }
}

// ---------- editor ----------

function RuleEditor({
  rule, meta, onClose, onSaved,
}: { rule?: any; meta: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { hasFeature } = useSession();
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [triggerType, setTriggerType] = useState(rule?.trigger_type ?? 'lead_created');
  const [triggerConfig, setTriggerConfig] = useState<Record<string, any>>(rule?.trigger_config ?? {});
  const [steps, setSteps] = useState<any[]>(rule?.steps ?? [
    { delay_minutes: 0, actions: [{ type: 'create_task', title: 'Follow up with {{lead.full_name}}', task_type: 'follow_up', priority: 'normal', due_in_minutes: 60 }], stop_if: [] },
  ]);
  const [stopOn, setStopOn] = useState<string[]>(rule?.stop_on ?? ['won', 'lost', 'paused']);
  const [saving, setSaving] = useState(false);

  const trigger = meta.triggers.find((t: any) => t.key === triggerType);
  const gated = !rule && !hasFeature('automation_advanced');

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name, description: description || undefined, trigger_type: triggerType,
        trigger_config: triggerConfig, steps, stop_on: stopOn, is_active: rule?.is_active ?? true,
      };
      if (rule) await patch(`/automations/${rule.id}`, payload);
      else await post('/automations', payload);
      onSaved();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  const updateStep = (index: number, next: any) =>
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, ...next } : step)));

  const updateAction = (stepIndex: number, actionIndex: number, next: any) =>
    setSteps((s) => s.map((step, i) => (
      i === stepIndex
        ? { ...step, actions: step.actions.map((a: any, j: number) => (j === actionIndex ? { ...a, ...next } : a)) }
        : step
    )));

  return (
    <Modal
      title={rule ? `Edit “${rule.name}”` : 'New automation'}
      subtitle="When something happens → wait → check → do these things."
      onClose={onClose} width="wide"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!name.trim() || gated} onClick={save}>
            {rule ? 'Save changes' : 'Create automation'}
          </Button>
        </>
      }
    >
      <div className="col gap-8">
        {gated && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <span>Custom automation is included from the Growth plan. The built-in rules keep working on Starter.</span>
          </div>
        )}

        <div className="grid c2">
          <Field label="Name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Big lead gone quiet" autoFocus />
          </Field>
          <Field label="Description" hint="What it is for, in one line.">
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>

        <section>
          <h3 className="mb-2">When</h3>
          <div className="grid c2">
            <Field label="Trigger">
              <select value={triggerType} onChange={(e) => { setTriggerType(e.target.value); setTriggerConfig({}); }}>
                {meta.triggers.map((t: any) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </Field>
            {(trigger?.config ?? []).map((field: any) => (
              <Field key={field.key} label={field.label}>
                {field.type === 'stage' ? (
                  <select value={triggerConfig[field.key] ?? ''} onChange={(e) => setTriggerConfig((c) => ({ ...c, [field.key]: e.target.value }))}>
                    <option value="">Any stage</option>
                    {meta.stages.map((s: any) => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                ) : field.type === 'select' ? (
                  <select value={triggerConfig[field.key] ?? ''} onChange={(e) => setTriggerConfig((c) => ({ ...c, [field.key]: e.target.value }))}>
                    <option value="">Any</option>
                    {field.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    type="number" value={triggerConfig[field.key] ?? ''}
                    onChange={(e) => setTriggerConfig((c) => ({ ...c, [field.key]: Number(e.target.value) }))}
                  />
                )}
              </Field>
            ))}
          </div>
        </section>

        <section>
          <div className="row between mb-2">
            <h3>Then</h3>
            <Button size="sm" icon="plus" onClick={() => setSteps((s) => [...s, { delay_minutes: 1440, actions: [{ type: 'create_task', title: 'Follow up', task_type: 'follow_up', priority: 'normal' }], stop_if: [] }])}>
              Add step
            </Button>
          </div>

          <div className="col gap-6">
            {steps.map((step, stepIndex) => (
              <div key={stepIndex} className="card" style={{ padding: 12 }}>
                <div className="row between wrap gap-4 mb-4">
                  <div className="row gap-4">
                    <span className="badge accent">Step {stepIndex + 1}</span>
                    <Field label="">
                      <div className="row gap-2">
                        <span className="small">Wait</span>
                        <input
                          type="number" min="0" style={{ width: 80, textAlign: 'right' }}
                          value={step.delay_minutes}
                          onChange={(e) => updateStep(stepIndex, { delay_minutes: Number(e.target.value) })}
                          aria-label="Delay in minutes"
                        />
                        <span className="small dim">minutes ({humanDelay(step.delay_minutes)})</span>
                      </div>
                    </Field>
                  </div>
                  {steps.length > 1 && (
                    <Button size="sm" variant="ghost" icon="trash" aria-label="Remove step" onClick={() => setSteps((s) => s.filter((_, i) => i !== stepIndex))} />
                  )}
                </div>

                <div className="col gap-4">
                  {step.actions.map((action: any, actionIndex: number) => (
                    <div key={actionIndex} className="card" style={{ padding: 10, background: 'var(--surface-2)' }}>
                      <div className="row gap-4 wrap">
                        <select
                          value={action.type} style={{ width: 'auto' }}
                          onChange={(e) => updateAction(stepIndex, actionIndex, { type: e.target.value })}
                          aria-label="Action"
                        >
                          {meta.actions.map((a: any) => <option key={a.key} value={a.key}>{a.label}</option>)}
                        </select>
                        <div className="grow" />
                        <Button
                          size="sm" variant="ghost" icon="trash" aria-label="Remove action"
                          onClick={() => updateStep(stepIndex, { actions: step.actions.filter((_: any, j: number) => j !== actionIndex) })}
                        />
                      </div>

                      <div className="grid c2 mt-4">
                        {['create_task', 'notify_owner', 'notify_assignee', 'notify_managers'].includes(action.type) && (
                          <Field label="Title" hint="Use {{lead.full_name}}, {{lead.value}}, {{quote.number}}.">
                            <input value={action.title ?? ''} onChange={(e) => updateAction(stepIndex, actionIndex, { title: e.target.value })} />
                          </Field>
                        )}
                        {action.type === 'create_task' && (
                          <>
                            <Field label="Task type">
                              <select value={action.task_type ?? 'follow_up'} onChange={(e) => updateAction(stepIndex, actionIndex, { task_type: e.target.value })}>
                                {['follow_up', 'call', 'email', 'whatsapp', 'meeting', 'quote', 'survey', 'admin', 'post_sale'].map((t) => (
                                  <option key={t} value={t}>{label(t)}</option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Priority">
                              <select value={action.priority ?? 'normal'} onChange={(e) => updateAction(stepIndex, actionIndex, { priority: e.target.value })}>
                                {['urgent', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{label(p)}</option>)}
                              </select>
                            </Field>
                            <Field label="Due in (minutes from the step)">
                              <input
                                type="number" min="0" value={action.due_in_minutes ?? 60}
                                onChange={(e) => updateAction(stepIndex, actionIndex, { due_in_minutes: Number(e.target.value) })}
                              />
                            </Field>
                          </>
                        )}
                        {['notify_owner', 'notify_assignee', 'notify_managers'].includes(action.type) && (
                          <>
                            <Field label="Body">
                              <input value={action.body ?? ''} onChange={(e) => updateAction(stepIndex, actionIndex, { body: e.target.value })} />
                            </Field>
                            <Field label="Severity">
                              <select value={action.severity ?? 'info'} onChange={(e) => updateAction(stepIndex, actionIndex, { severity: e.target.value })}>
                                {['info', 'warning', 'critical', 'success'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
                              </select>
                            </Field>
                          </>
                        )}
                        {action.type === 'send_template' && (
                          <>
                            <Field label="Template">
                              <select value={action.template_key ?? ''} onChange={(e) => updateAction(stepIndex, actionIndex, { template_key: e.target.value })}>
                                <option value="">Choose a template</option>
                                {meta.templates.map((t: any) => <option key={t.key} value={t.key}>{t.name}</option>)}
                              </select>
                            </Field>
                            <Field label="Channel" hint="Nothing is sent unless that channel is connected.">
                              <select value={action.channel ?? 'email'} onChange={(e) => updateAction(stepIndex, actionIndex, { channel: e.target.value })}>
                                <option value="email">Email</option>
                                <option value="whatsapp">WhatsApp</option>
                              </select>
                            </Field>
                          </>
                        )}
                        {action.type === 'change_stage' && (
                          <Field label="Stage">
                            <select value={action.stage_key ?? ''} onChange={(e) => updateAction(stepIndex, actionIndex, { stage_key: e.target.value })}>
                              <option value="">Choose a stage</option>
                              {meta.stages.map((s: any) => <option key={s.key} value={s.key}>{s.name}</option>)}
                            </select>
                          </Field>
                        )}
                        {action.type === 'add_tag' && (
                          <Field label="Tag">
                            <input value={action.tag ?? ''} onChange={(e) => updateAction(stepIndex, actionIndex, { tag: e.target.value })} />
                          </Field>
                        )}
                      </div>
                    </div>
                  ))}
                  <Button
                    size="sm" icon="plus"
                    onClick={() => updateStep(stepIndex, { actions: [...step.actions, { type: 'notify_owner', title: 'Check this lead' }] })}
                  >
                    Add action
                  </Button>
                </div>

                <Field label="Skip the rest of the sequence if" hint="Checked before this step runs.">
                  <div className="chips">
                    {meta.stop_conditions.map((condition: any) => (
                      <button
                        key={condition.key} type="button"
                        className={`chip ${(step.stop_if ?? []).includes(condition.key) ? 'on' : ''}`}
                        onClick={() => updateStep(stepIndex, {
                          stop_if: (step.stop_if ?? []).includes(condition.key)
                            ? step.stop_if.filter((c: string) => c !== condition.key)
                            : [...(step.stop_if ?? []), condition.key],
                        })}
                      >
                        {condition.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2">Stop the whole sequence when</h3>
          <div className="chips">
            {meta.stop_conditions.map((condition: any) => (
              <button
                key={condition.key} type="button"
                className={`chip ${stopOn.includes(condition.key) ? 'on' : ''}`}
                onClick={() => setStopOn((s) => (s.includes(condition.key) ? s.filter((c) => c !== condition.key) : [...s, condition.key]))}
              >
                {condition.label}
              </button>
            ))}
          </div>
          <p className="hint mt-2" style={{ marginBottom: 0 }}>
            Never chase a customer who has already replied — that is what these conditions are for.
          </p>
        </section>
      </div>
    </Modal>
  );
}
