import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge, Button, Card, EmptyState, ErrorBlock, Field, Icon, Kpi, LoadingBlock, Modal, Tabs, useToast,
} from '../components/ui';
import { money, date, label, toInputDate, relative } from '../lib/format';

const INSTALL_STAGES = ['not_started', 'scheduled', 'in_progress', 'commissioned', 'handed_over'];

export default function Projects() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { organization, can } = useSession();
  const currency = organization?.currency ?? 'EUR';
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<any>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projects', filter],
    queryFn: () => get(`/projects${filter === 'all' ? '' : `?installation_status=${filter}`}`),
  });

  const projects = data?.projects ?? [];
  const summary = data?.summary ?? { pipeline_value: 0, outstanding: 0 };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Installations</h1>
          <p className="muted small" style={{ margin: 0 }}>
            What happens after “won” — scheduling, technicians, payment and warranty.
          </p>
        </div>
      </div>

      <div className="kpi-grid mb-6">
        <Kpi label="Contracted value" value={money(summary.pipeline_value, currency)} sub={`${projects.length} projects in view`} />
        <Kpi label="Outstanding payments" value={money(summary.outstanding, currency)} tone={summary.outstanding > 0 ? 'warn' : 'good'} />
        <Kpi label="Awaiting scheduling" value={projects.filter((p: any) => p.installation_status === 'not_started').length} />
        <Kpi label="Handed over" value={projects.filter((p: any) => p.installation_status === 'handed_over').length} tone="good" />
      </div>

      <Card padded={false}>
        <div style={{ padding: '0 14px' }}>
          <Tabs
            active={filter} onChange={setFilter}
            tabs={[
              { key: 'all', label: 'All' },
              ...INSTALL_STAGES.map((stage) => ({ key: stage, label: label(stage) })),
            ]}
          />
        </div>

        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={4} height={50} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon="projects" title="No installations here"
            message="A project is created automatically when a deal is won, so your installation team picks it up from the same system."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th><th className="hide-mobile">Customer</th><th>Installation</th>
                  <th className="hide-mobile">Planned</th><th className="hide-mobile">Technician</th>
                  <th className="num">Value</th><th>Payment</th><th />
                </tr>
              </thead>
              <tbody>
                {projects.map((project: any) => (
                  <tr key={project.id} style={{ cursor: 'default' }}>
                    <td>
                      <div className="strong truncate" style={{ maxWidth: 240 }}>{project.name}</div>
                      <div className="tiny dim">{label(project.project_type)}{project.system_size ? ` · ${project.system_size}` : ''}</div>
                    </td>
                    <td className="hide-mobile">
                      <button
                        className="grow" style={{ border: 0, background: 'none', padding: 0, font: 'inherit', color: 'var(--accent-ink)', cursor: 'pointer' }}
                        onClick={() => navigate(`/app/customers/${project.customer_id}`)}
                      >
                        {project.customer_name}
                      </button>
                    </td>
                    <td>
                      <Badge tone={project.installation_status === 'handed_over' ? 'good' : project.installation_status === 'not_started' ? 'warm' : 'cold'}>
                        {label(project.installation_status)}
                      </Badge>
                    </td>
                    <td className="hide-mobile small">
                      {project.planned_install_date ? date(project.planned_install_date) : <span className="dim">not set</span>}
                    </td>
                    <td className="hide-mobile small">{project.technician_name ?? <span className="dim">unassigned</span>}</td>
                    <td className="num strong nowrap">{money(project.contract_value, currency)}</td>
                    <td>
                      <Badge tone={project.payment_status === 'paid' ? 'good' : project.payment_status === 'unpaid' ? 'danger' : 'warm'}>
                        {label(project.payment_status)}
                      </Badge>
                      {project.amount_paid > 0 && project.payment_status !== 'paid' && (
                        <div className="tiny dim">{money(project.amount_paid, currency)} received</div>
                      )}
                    </td>
                    <td>
                      {can('projects:write') && <Button size="sm" icon="edit" onClick={() => setEditing(project)} aria-label="Edit project" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <ProjectDialog
          project={editing} currency={currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['projects'] });
            toast.success('Project updated.');
          }}
        />
      )}
    </div>
  );
}

function ProjectDialog({
  project, currency, onClose, onSaved,
}: { project: any; currency: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    installation_status: project.installation_status,
    status: project.status,
    planned_install_date: toInputDate(project.planned_install_date),
    actual_install_date: toInputDate(project.actual_install_date),
    technician_id: project.technician_id ?? '',
    payment_status: project.payment_status,
    amount_paid: String(project.amount_paid ?? 0),
    warranty_years: String(project.warranty_years ?? ''),
    maintenance_due_at: toInputDate(project.maintenance_due_at),
    technical_notes: project.technical_notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const { data: users } = useQuery({ queryKey: ['users-light'], queryFn: () => get('/settings/users'), staleTime: 300_000 });
  const set = (key: string) => (e: any) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Modal
      title={project.name} subtitle={`${project.customer_name} · ${money(project.contract_value, currency)}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await patch(`/projects/${project.id}`, {
                  installation_status: form.installation_status,
                  status: form.status,
                  planned_install_date: form.planned_install_date ? new Date(form.planned_install_date).toISOString() : null,
                  actual_install_date: form.actual_install_date ? new Date(form.actual_install_date).toISOString() : null,
                  technician_id: form.technician_id || null,
                  payment_status: form.payment_status,
                  amount_paid: Number(form.amount_paid) || 0,
                  warranty_years: form.warranty_years ? Number(form.warranty_years) : null,
                  maintenance_due_at: form.maintenance_due_at ? new Date(form.maintenance_due_at).toISOString() : null,
                  technical_notes: form.technical_notes || null,
                });
                onSaved();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="grid c2">
          <Field label="Installation status">
            <select value={form.installation_status} onChange={set('installation_status')}>
              {INSTALL_STAGES.map((stage) => <option key={stage} value={stage}>{label(stage)}</option>)}
            </select>
          </Field>
          <Field label="Project status">
            <select value={form.status} onChange={set('status')}>
              {['won', 'scheduled', 'in_progress', 'commissioned', 'completed', 'cancelled'].map((s) => (
                <option key={s} value={s}>{label(s)}</option>
              ))}
            </select>
          </Field>
          <Field label="Planned installation date">
            <input type="date" value={form.planned_install_date} onChange={set('planned_install_date')} />
          </Field>
          <Field label="Actual installation date">
            <input type="date" value={form.actual_install_date} onChange={set('actual_install_date')} />
          </Field>
          <Field label="Technician">
            <select value={form.technician_id} onChange={set('technician_id')}>
              <option value="">Unassigned</option>
              {(users?.users ?? []).filter((u: any) => u.status === 'active').map((u: any) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Payment status">
            <select value={form.payment_status} onChange={set('payment_status')}>
              {['unpaid', 'deposit_paid', 'partially_paid', 'paid'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </Field>
          <Field label={`Amount received (${currency})`}>
            <input type="number" min="0" step="100" value={form.amount_paid} onChange={set('amount_paid')} />
          </Field>
          <Field label="Warranty (years)">
            <input type="number" min="0" max="30" value={form.warranty_years} onChange={set('warranty_years')} />
          </Field>
          <Field label="Maintenance due" hint="Creates the reminder for the next service visit.">
            <input type="date" value={form.maintenance_due_at} onChange={set('maintenance_due_at')} />
          </Field>
        </div>
        <Field label="Technical notes">
          <textarea rows={4} value={form.technical_notes} onChange={set('technical_notes')} placeholder="Serial numbers, commissioning readings, anything service will need." />
        </Field>
      </div>
    </Modal>
  );
}
