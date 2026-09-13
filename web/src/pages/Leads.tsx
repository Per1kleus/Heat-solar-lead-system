import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, download } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock, Modal,
  SearchInput, TemperatureBadge, useDebounced, useToast,
} from '../components/ui';
import LeadForm from '../components/LeadForm';
import { money, relative, isOverdue, projectTypeLabel, label } from '../lib/format';

const PAGE_SIZE = 40;

export default function Leads() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { organization, can } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const [search, setSearch] = useState(params.get('search') ?? '');
  const debouncedSearch = useDebounced(search, 300);
  const [showNew, setShowNew] = useState(params.get('new') === '1');
  const [showFilters, setShowFilters] = useState(false);
  const [showSaveView, setShowSaveView] = useState(false);
  const [offset, setOffset] = useState(0);

  const filters = useMemo(() => ({
    status: params.get('status') ?? 'open',
    stage_id: params.get('stage_id') ?? '',
    source_id: params.get('source_id') ?? '',
    temperature: params.get('temperature') ?? '',
    owner_id: params.get('owner_id') ?? '',
    project_type: params.get('project_type') ?? '',
    min_value: params.get('min_value') ?? '',
    min_score: params.get('min_score') ?? '',
    city: params.get('city') ?? '',
    tag_id: params.get('tag_id') ?? '',
    flag: params.get('flag') ?? '',
    sort: params.get('sort') ?? 'created_at',
    dir: params.get('dir') ?? 'desc',
  }), [params]);

  useEffect(() => { setOffset(0); }, [debouncedSearch, params.toString()]);

  const queryString = useMemo(() => {
    const q = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) q.set(key, value); });
    if (debouncedSearch.trim()) q.set('search', debouncedSearch.trim());
    q.set('limit', String(PAGE_SIZE));
    q.set('offset', String(offset));
    return q.toString();
  }, [filters, debouncedSearch, offset]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['leads', queryString],
    queryFn: () => get(`/leads?${queryString}`),
    placeholderData: (prev) => prev,
  });

  const { data: meta } = useQuery({
    queryKey: ['lead-filters'],
    queryFn: async () => {
      const [stages, sources, users, tags, views] = await Promise.all([
        get('/settings/stages'), get('/settings/sources'),
        can('leads:read:all') ? get('/settings/users') : Promise.resolve({ users: [] }),
        get('/settings/tags'), get('/data/views'),
      ]);
      return { stages: stages.stages, sources: sources.sources, users: users.users ?? [], tags: tags.tags, views: views.views };
    },
    staleTime: 300_000,
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('new');
    setParams(next, { replace: true });
  };

  const activeFilterCount = Object.entries(filters)
    .filter(([key, value]) => value && !['sort', 'dir'].includes(key) && !(key === 'status' && value === 'open')).length;

  const sortBy = (column: string) => {
    const next = new URLSearchParams(params);
    if (filters.sort === column) next.set('dir', filters.dir === 'asc' ? 'desc' : 'asc');
    else { next.set('sort', column); next.set('dir', 'desc'); }
    setParams(next, { replace: true });
  };

  const applyView = (view: any) => {
    const next = new URLSearchParams();
    Object.entries(view.filters ?? {}).forEach(([key, value]) => { if (value) next.set(key, String(value)); });
    setParams(next, { replace: true });
    setShowFilters(false);
  };

  const leads = data?.leads ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {data ? `${data.total.toLocaleString()} lead${data.total === 1 ? '' : 's'} · ${money(data.total_value, currency)} total value` : 'Loading…'}
          </p>
        </div>
        <div className="row gap-4 wrap">
          {can('data:import') && <Button icon="upload" onClick={() => navigate('/app/import')}>Import</Button>}
          {can('data:export') && (
            <Button icon="download" onClick={() => download('/data/export/leads', `leads-${new Date().toISOString().slice(0, 10)}.csv`).catch(toast.error)}>
              Export
            </Button>
          )}
          {can('leads:write') && <Button icon="plus" variant="primary" onClick={() => setShowNew(true)}>New lead</Button>}
        </div>
      </div>

      <Card padded={false}>
        <div className="card-body tight row gap-4 wrap">
          <SearchInput value={search} onChange={setSearch} placeholder="Name, phone, email, reference, city…" />

          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={{ width: 'auto' }} aria-label="Status">
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="open,won,lost">All statuses</option>
          </select>

          <select value={filters.temperature} onChange={(e) => setFilter('temperature', e.target.value)} style={{ width: 'auto' }} aria-label="Temperature">
            <option value="">Any temperature</option>
            <option value="hot">🔥 Hot</option>
            <option value="warm">🟡 Warm</option>
            <option value="cold">🔵 Cold</option>
          </select>

          <select value={filters.flag} onChange={(e) => setFilter('flag', e.target.value)} style={{ width: 'auto' }} aria-label="Flag">
            <option value="">No flag filter</option>
            <option value="no_next_action">⚠ No next action</option>
            <option value="overdue">🔴 Overdue follow-up</option>
            <option value="recovery">🔄 Recovery scheduled</option>
          </select>

          <Button icon="filter" onClick={() => setShowFilters(true)}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>

          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</Button>
          )}
          <div className="grow" />
          {isFetching && <span className="spinner" style={{ color: 'var(--ink-3)' }} />}
        </div>

        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={6} height={40} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : leads.length === 0 ? (
          <EmptyState
            icon="leads"
            title={debouncedSearch || activeFilterCount > 0 ? 'No leads match these filters' : 'No leads yet'}
            message={debouncedSearch || activeFilterCount > 0
              ? 'Try widening the search or clearing a filter.'
              : 'Create one by hand, import your spreadsheet, or put the web form on your website.'}
            action={
              <div className="row gap-4" style={{ justifyContent: 'center' }}>
                {can('leads:write') && <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>New lead</Button>}
                {can('data:import') && <Button size="sm" onClick={() => navigate('/app/import')}>Import CSV</Button>}
              </div>
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => sortBy('name')}>Customer</th>
                    <th className="hide-mobile">Project</th>
                    <th className="hide-mobile">Stage</th>
                    <th className="sortable" onClick={() => sortBy('score')}>Temp / score</th>
                    <th className="sortable num" onClick={() => sortBy('estimated_value')}>Value</th>
                    <th className="sortable" onClick={() => sortBy('next_action')}>Next action</th>
                    <th className="hide-mobile">Owner</th>
                    <th className="sortable hide-mobile" onClick={() => sortBy('last_activity_at')}>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead: any) => (
                    <tr key={lead.id} onClick={() => navigate(`/app/leads/${lead.id}`)}>
                      <td>
                        <div className="strong truncate" style={{ maxWidth: 210 }}>{lead.full_name}</div>
                        <div className="tiny dim truncate" style={{ maxWidth: 210 }}>
                          {lead.reference} · {lead.city || 'no city'}{lead.source_name ? ` · ${lead.source_name}` : ''}
                        </div>
                      </td>
                      <td className="hide-mobile small">{projectTypeLabel(lead.project_types)}</td>
                      <td className="hide-mobile">
                        {lead.status === 'open' ? (
                          <span className="row gap-4 small nowrap">
                            <span className="dot" style={{ color: lead.stage_color }} />{lead.stage_name}
                          </span>
                        ) : (
                          <Badge tone={lead.status === 'won' ? 'good' : 'danger'}>{label(lead.status)}</Badge>
                        )}
                      </td>
                      <td><TemperatureBadge temperature={lead.temperature} score={lead.score} /></td>
                      <td className="num strong nowrap">{money(lead.estimated_value, currency)}</td>
                      <td>
                        {lead.next_task_title ? (
                          <div style={{ maxWidth: 220 }}>
                            <div className="truncate small">{lead.next_task_title}</div>
                            <div className="tiny" style={{ color: isOverdue(lead.next_task_due_at) ? 'var(--danger)' : 'var(--ink-3)' }}>
                              {isOverdue(lead.next_task_due_at) ? '● ' : ''}{relative(lead.next_task_due_at)}
                            </div>
                          </div>
                        ) : lead.status === 'open' ? (
                          <Badge tone="warm">⚠ none</Badge>
                        ) : <span className="dim">—</span>}
                      </td>
                      <td className="hide-mobile">
                        {lead.owner_name
                          ? <span className="row gap-4 nowrap"><Avatar name={lead.owner_name} color={lead.owner_color} size="sm" /><span className="small hide-mobile">{lead.owner_first_name}</span></span>
                          : <Badge tone="warm">Unassigned</Badge>}
                      </td>
                      <td className="hide-mobile small dim nowrap">{lead.last_activity_at ? relative(lead.last_activity_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-foot row between">
              <span className="small muted">
                Showing {offset + 1}–{Math.min(offset + leads.length, data.total)} of {data.total.toLocaleString()}
              </span>
              <div className="row gap-4">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>Previous</Button>
                <Button size="sm" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {showNew && (
        <LeadForm
          onClose={() => { setShowNew(false); setFilter('new', ''); }}
          onSaved={(lead) => {
            setShowNew(false);
            queryClient.invalidateQueries({ queryKey: ['leads'] });
            navigate(`/app/leads/${lead.id}`);
          }}
        />
      )}

      {showFilters && (
        <Modal
          title="Filter leads" onClose={() => setShowFilters(false)}
          footer={
            <>
              <Button onClick={() => { setParams(new URLSearchParams(), { replace: true }); setShowFilters(false); }}>Clear all</Button>
              <Button variant="primary" onClick={() => setShowFilters(false)}>Done</Button>
            </>
          }
        >
          <div className="col gap-6">
            {(meta?.views?.length ?? 0) > 0 && (
              <div className="field">
                <label>Saved views</label>
                <div className="chips">
                  {meta!.views.map((view: any) => (
                    <button key={view.id} type="button" className="chip" onClick={() => applyView(view)}>
                      {view.name}{view.is_shared ? ' · shared' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid c2">
              <div className="field">
                <label>Stage</label>
                <select value={filters.stage_id} onChange={(e) => setFilter('stage_id', e.target.value)}>
                  <option value="">Any stage</option>
                  {(meta?.stages ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Source</label>
                <select value={filters.source_id} onChange={(e) => setFilter('source_id', e.target.value)}>
                  <option value="">Any source</option>
                  {(meta?.sources ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {can('leads:read:all') && (
                <div className="field">
                  <label>Salesperson</label>
                  <select value={filters.owner_id} onChange={(e) => setFilter('owner_id', e.target.value)}>
                    <option value="">Anyone</option>
                    <option value="unassigned">Unassigned</option>
                    {(meta?.users ?? []).filter((u: any) => u.role !== 'technician').map((u: any) => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label>Project type</label>
                <select value={filters.project_type} onChange={(e) => setFilter('project_type', e.target.value)}>
                  <option value="">Any</option>
                  <option value="pv">Photovoltaic</option>
                  <option value="heat_pump">Heat pump</option>
                  <option value="battery">Battery</option>
                  <option value="ev_charger">EV charger</option>
                </select>
              </div>
              <div className="field">
                <label>Minimum value (€)</label>
                <input type="number" min="0" step="1000" value={filters.min_value} onChange={(e) => setFilter('min_value', e.target.value)} />
              </div>
              <div className="field">
                <label>Minimum score</label>
                <input type="number" min="0" max="100" step="10" value={filters.min_score} onChange={(e) => setFilter('min_score', e.target.value)} />
              </div>
              <div className="field">
                <label>City</label>
                <input value={filters.city} onChange={(e) => setFilter('city', e.target.value)} placeholder="Thessaloniki" />
              </div>
              <div className="field">
                <label>Tag</label>
                <select value={filters.tag_id} onChange={(e) => setFilter('tag_id', e.target.value)}>
                  <option value="">Any tag</option>
                  {(meta?.tags ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.usage_count})</option>)}
                </select>
              </div>
            </div>

            <Button icon="plus" onClick={() => setShowSaveView(true)}>Save this filter as a view</Button>
          </div>
        </Modal>
      )}

      {showSaveView && (
        <SaveViewDialog
          filters={filters}
          onClose={() => setShowSaveView(false)}
          onSaved={() => { setShowSaveView(false); toast.success('View saved.'); }}
        />
      )}
    </div>
  );
}

function SaveViewDialog({ filters, onClose, onSaved }: { filters: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const save = async () => {
    setSaving(true);
    try {
      await post('/data/views', { name, entity: 'lead', filters, is_shared: shared });
      queryClient.invalidateQueries({ queryKey: ['lead-filters'] });
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Save this view" onClose={onClose} width="narrow"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!name.trim()} onClick={save}>Save view</Button></>}
    >
      <div className="col gap-6">
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hot PV leads over €10k" autoFocus />
        </div>
        <label className="check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>Share with the whole team</span>
        </label>
      </div>
    </Modal>
  );
}
