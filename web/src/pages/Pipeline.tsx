import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useSensor, useSensors,
  useDraggable, useDroppable, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock,
  SearchInput, TemperatureBadge, useDebounced, useToast,
} from '../components/ui';
import LeadForm from '../components/LeadForm';
import { money, moneyShort, relative, isOverdue, projectTypeLabel } from '../lib/format';

export default function Pipeline() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { organization, can } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [dragging, setDragging] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);

  const filters = {
    owner_id: params.get('owner_id') ?? '',
    project_type: params.get('project_type') ?? '',
    temperature: params.get('temperature') ?? '',
  };

  const queryString = useMemo(() => {
    const q = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) q.set(key, value); });
    if (debounced.trim()) q.set('search', debounced.trim());
    return q.toString();
  }, [params, debounced]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pipeline', queryString],
    queryFn: () => get(`/pipeline?${queryString}`),
    placeholderData: (prev) => prev,
  });

  const { data: users } = useQuery({
    queryKey: ['users-light'],
    queryFn: () => get('/settings/users'),
    enabled: can('leads:read:all'),
    staleTime: 300_000,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const onDragEnd = async (event: DragEndEvent) => {
    setDragging(null);
    const leadId = String(event.active.id);
    const stageId = event.over ? String(event.over.id) : null;
    if (!stageId) return;
    const lead = data.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === leadId);
    if (!lead || lead.stage_id === stageId) return;

    const stage = data.columns.find((c: any) => c.id === stageId);
    if (stage?.type === 'lost') {
      toast.show('Open the lead and use “Mark lost” so a reason is recorded.', 'error');
      return;
    }

    // Optimistic move; rolled back if the server rejects it.
    const previous = queryClient.getQueryData(['pipeline', queryString]);
    queryClient.setQueryData(['pipeline', queryString], (old: any) => {
      if (!old) return old;
      const columns = old.columns.map((column: any) => {
        if (column.id === lead.stage_id) {
          const cards = column.cards.filter((c: any) => c.id !== leadId);
          return { ...column, cards, count: cards.length, value: cards.reduce((s: number, c: any) => s + c.estimated_value, 0) };
        }
        if (column.id === stageId) {
          const cards = [{ ...lead, stage_id: stageId, days_in_stage: 0 }, ...column.cards];
          return { ...column, cards, count: cards.length, value: cards.reduce((s: number, c: any) => s + c.estimated_value, 0) };
        }
        return column;
      });
      return { ...old, columns };
    });

    try {
      await post('/pipeline/move', { lead_id: leadId, stage_id: stageId });
      queryClient.invalidateQueries({ queryKey: ['pipeline'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(`${lead.full_name} moved to ${stage?.name}.`);
    } catch (err) {
      queryClient.setQueryData(['pipeline', queryString], previous);
      toast.error(err);
    }
  };

  if (isLoading) return <div className="page"><LoadingBlock rows={2} height={300} /></div>;
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const openColumns = data.columns.filter((c: any) => c.type !== 'lost');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {data.totals.count} deals · {money(data.totals.value, currency)} open ·{' '}
            {money(data.totals.weighted, currency)} weighted
          </p>
        </div>
        <div className="row gap-4 wrap">
          <SearchInput value={search} onChange={setSearch} placeholder="Filter cards…" />
          {can('leads:read:all') && (
            <select value={filters.owner_id} onChange={(e) => setFilter('owner_id', e.target.value)} style={{ width: 'auto' }} aria-label="Salesperson">
              <option value="">Everyone</option>
              {(users?.users ?? []).filter((u: any) => u.role !== 'technician').map((u: any) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          )}
          <select value={filters.project_type} onChange={(e) => setFilter('project_type', e.target.value)} style={{ width: 'auto' }} aria-label="Project type">
            <option value="">All products</option>
            <option value="pv">Photovoltaic</option>
            <option value="heat_pump">Heat pump</option>
            <option value="battery">Battery</option>
            <option value="ev_charger">EV charger</option>
          </select>
          {can('leads:write') && <Button icon="plus" variant="primary" onClick={() => setShowNew(true)}>New lead</Button>}
        </div>
      </div>

      {data.totals.count === 0 ? (
        <Card>
          <EmptyState
            icon="pipeline" title="The board is empty"
            message="Leads appear here the moment they arrive from your website, the API or a manual entry."
            action={can('leads:write') ? <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>Add the first lead</Button> : undefined}
          />
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={(event: DragStartEvent) => {
            const id = String(event.active.id);
            setDragging(data.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === id));
          }}
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
        >
          <div className="board">
            {openColumns.map((column: any) => (
              <Column key={column.id} column={column} currency={currency} onOpen={(id) => navigate(`/app/leads/${id}`)} />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging ? <LeadCard lead={dragging} currency={currency} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {showNew && (
        <LeadForm
          onClose={() => setShowNew(false)}
          onSaved={(lead) => { setShowNew(false); navigate(`/app/leads/${lead.id}`); }}
        />
      )}
    </div>
  );
}

function Column({ column, currency, onOpen }: { column: any; currency: string; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <div ref={setNodeRef} className={`board-col ${isOver ? 'over' : ''}`}>
      <div className="board-col-head">
        <div className="board-col-bar" style={{ background: column.color }} />
        <div className="row between">
          <span className="strong small">{column.name}</span>
          <span className="badge">{column.count}</span>
        </div>
        <div className="tiny dim" style={{ marginTop: 2 }}>
          {moneyShort(column.value, currency)}
          {column.type === 'open' && ` · ${column.probability}% · ${moneyShort(column.weighted, currency)} weighted`}
        </div>
      </div>
      <div className="board-cards">
        {column.cards.length === 0 && <div className="tiny dim center" style={{ padding: 14 }}>Drop a lead here</div>}
        {column.cards.map((lead: any) => (
          <DraggableCard key={lead.id} lead={lead} currency={currency} staleDays={column.stale_days} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function DraggableCard({ lead, currency, staleDays, onOpen }: { lead: any; currency: string; staleDays: number; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id });
  return (
    <div
      ref={setNodeRef} {...listeners} {...attributes}
      onClick={() => !isDragging && onOpen(lead.id)}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(lead.id); }}
      style={{ outline: 'none' }}
    >
      <LeadCard lead={lead} currency={currency} staleDays={staleDays} dragging={isDragging} />
    </div>
  );
}

function LeadCard({
  lead, currency, staleDays = 7, dragging, overlay,
}: { lead: any; currency: string; staleDays?: number; dragging?: boolean; overlay?: boolean }) {
  const stale = staleDays > 0 && lead.days_in_stage !== null && lead.days_in_stage > staleDays;
  const noAction = lead.status === 'open' && !lead.next_task_id;
  return (
    <article
      className={`board-card ${dragging ? 'dragging' : ''} ${noAction ? 'no-action' : stale ? 'stale' : ''}`}
      style={overlay ? { width: 258, boxShadow: 'var(--shadow-lg)', cursor: 'grabbing' } : undefined}
    >
      <div className="row between gap-4">
        <span className="strong truncate">{lead.full_name}</span>
        <TemperatureBadge temperature={lead.temperature} />
      </div>
      <div className="tiny dim truncate">
        {projectTypeLabel(lead.project_types)}{lead.city ? ` · ${lead.city}` : ''}
      </div>
      <div className="row between">
        <span className="strong">{money(lead.estimated_value, currency)}</span>
        {lead.owner_name ? <Avatar name={lead.owner_name} color={lead.owner_color} size="sm" /> : <Badge tone="warm">?</Badge>}
      </div>
      <div className="tiny" style={{ color: noAction ? 'var(--danger)' : lead.next_task_due_at && isOverdue(lead.next_task_due_at) ? 'var(--danger)' : 'var(--ink-3)' }}>
        {noAction ? (
          <span className="row gap-2"><Icon name="alert" size={11} />No next action</span>
        ) : lead.next_task_title ? (
          <span className="truncate" style={{ display: 'block' }}>→ {lead.next_task_title} · {relative(lead.next_task_due_at)}</span>
        ) : '—'}
      </div>
      {lead.days_in_stage !== null && (
        <div className="tiny dim row between">
          <span>{lead.days_in_stage} day{lead.days_in_stage === 1 ? '' : 's'} in stage</span>
          {stale && <span style={{ color: 'var(--warm)' }}>stalling</span>}
        </div>
      )}
    </article>
  );
}
