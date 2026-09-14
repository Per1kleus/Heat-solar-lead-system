import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock, Tabs, useToast } from '../components/ui';
import { time, dateTime, isOverdue, label } from '../lib/format';
import AppointmentOutcome from '../components/AppointmentOutcome';

type View = 'day' | 'week' | 'month';

export default function Calendar() {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dragEvent, setDragEvent] = useState<any>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [closing, setClosing] = useState<any | null>(null);

  const { from, to, days } = useMemo(() => buildRange(view, anchor), [view, anchor]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['calendar', from.toISOString(), to.toISOString()],
    queryFn: () => get(`/calendar?from=${from.toISOString()}&to=${to.toISOString()}`),
  });

  const events = data?.events ?? [];
  const byDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const event of events) {
      const key = new Date(event.start).toDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [events]);

  const shift = (direction: number) => {
    const next = new Date(anchor);
    if (view === 'day') next.setDate(next.getDate() + direction);
    if (view === 'week') next.setDate(next.getDate() + direction * 7);
    if (view === 'month') next.setMonth(next.getMonth() + direction);
    setAnchor(next);
  };

  /** Drag-and-drop rescheduling: tasks move their due date, appointments their start. */
  const reschedule = async (event: any, day: Date) => {
    const original = new Date(event.start);
    const target = new Date(day);
    target.setHours(original.getHours(), original.getMinutes(), 0, 0);
    if (target.toDateString() === original.toDateString()) return;
    try {
      if (event.kind === 'task') {
        await post(`/tasks/${event.id}/reschedule`, { due_at: target.toISOString() });
      } else if (event.kind === 'appointment') {
        await post(`/appointments/${event.id}`, { starts_at: target.toISOString() }, { method: 'PATCH' } as any);
      } else {
        toast.show('Quotation deadlines are changed on the quotation itself.', 'error');
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      toast.success(`Moved to ${target.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.`);
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Follow-ups, calls, site surveys, appointments and quotation deadlines together.
          </p>
        </div>
        <div className="row gap-4 wrap">
          <div className="row gap-2">
            <Button size="sm" icon="chevron" onClick={() => shift(-1)} aria-label="Previous" style={{ transform: 'rotate(180deg)' }} />
            <Button size="sm" onClick={() => setAnchor(new Date())}>Today</Button>
            <Button size="sm" icon="chevron" onClick={() => shift(1)} aria-label="Next" />
          </div>
          <Tabs
            active={view} onChange={(key) => setView(key as View)}
            tabs={[{ key: 'day', label: 'Day' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }]}
          />
        </div>
      </div>

      <Card
        title={rangeLabel(view, anchor)}
        subtitle={`${events.length} item${events.length === 1 ? '' : 's'} in view`}
        padded={false}
      >
        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={4} height={70} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : view === 'day' ? (
          <DayList
            events={byDay.get(anchor.toDateString()) ?? []}
            onOpen={(event) => event.lead_id && navigate(`/app/leads/${event.lead_id}`)}
            onClose={(event) => setClosing({ id: event.id, title: event.title, starts_at: event.start })}
          />
        ) : (
          <>
            <div className="cal-grid">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                <div key={day} className="cal-head">{day}</div>
              ))}
              {days.map((day) => {
                const key = day.toDateString();
                const dayEvents = byDay.get(key) ?? [];
                const isToday = key === new Date().toDateString();
                const otherMonth = view === 'month' && day.getMonth() !== anchor.getMonth();
                return (
                  <div
                    key={key}
                    className={`cal-cell ${otherMonth ? 'dim-month' : ''} ${isToday ? 'today' : ''} ${dropTarget === key ? 'drop' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDropTarget(key); }}
                    onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropTarget(null);
                      if (dragEvent) reschedule(dragEvent, day);
                      setDragEvent(null);
                    }}
                  >
                    <span className="cal-date">{day.getDate()}</span>
                    {dayEvents.slice(0, view === 'week' ? 12 : 4).map((event) => (
                      <div
                        key={`${event.kind}-${event.id}`}
                        className={`cal-event ${event.kind} ${event.kind === 'task' && isOverdue(event.start) ? 'overdue' : ''}`}
                        draggable={event.kind !== 'quote_deadline'}
                        onDragStart={() => setDragEvent(event)}
                        onDragEnd={() => setDragEvent(null)}
                        onClick={() => event.lead_id && navigate(`/app/leads/${event.lead_id}`)}
                        title={`${time(event.start)} ${event.title}${event.subtitle ? ` — ${event.subtitle}` : ''}`}
                      >
                        {time(event.start)} {event.title}
                      </div>
                    ))}
                    {dayEvents.length > (view === 'week' ? 12 : 4) && (
                      <span className="tiny dim">+{dayEvents.length - (view === 'week' ? 12 : 4)} more</span>
                    )}
                  </div>
                );
              })}
            </div>
            {events.length === 0 && (
              <EmptyState icon="calendar" title="Nothing scheduled" message="Follow-ups and appointments appear here as soon as they are booked." />
            )}
          </>
        )}
      </Card>

      <div className="row gap-6 wrap mt-4 small muted">
        <span className="row gap-2"><span className="cal-event task" style={{ padding: '1px 6px' }}>Follow-up</span></span>
        <span className="row gap-2"><span className="cal-event" style={{ padding: '1px 6px' }}>Appointment</span></span>
        <span className="row gap-2"><span className="cal-event quote_deadline" style={{ padding: '1px 6px' }}>Quote expiry</span></span>
        <span className="dim">Drag an item to another day to reschedule it.</span>
      </div>

      {closing && (
        <AppointmentOutcome
          appointment={closing}
          onClose={() => setClosing(null)}
          onSaved={() => { setClosing(null); refetch(); }}
        />
      )}
    </div>
  );
}

function DayList({
  events, onOpen, onClose,
}: { events: any[]; onOpen: (event: any) => void; onClose: (event: any) => void }) {
  if (events.length === 0) {
    return <EmptyState icon="calendar" title="Nothing scheduled today" message="Enjoy it, or pick up a lead from the pipeline." />;
  }
  return (
    <div>
      {events.map((event) => (
        // The row is a card with its own action, so the clickable part is the
        // inner button rather than the whole row.
        <div
          key={`${event.kind}-${event.id}`} className="attention-item"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <button
            className="row gap-4 grow"
            style={{ minWidth: 0, textAlign: 'left', border: 0, background: 'none', font: 'inherit', cursor: 'pointer', padding: 0 }}
            onClick={() => onOpen(event)}
          >
            <span style={{ minWidth: 52 }} className="strong">{time(event.start)}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="truncate strong" style={{ display: 'block' }}>{event.title}</span>
              <span className="tiny dim truncate" style={{ display: 'block' }}>
                {event.subtitle ?? ''}{event.owner ? ` · ${event.owner}` : ''}
              </span>
            </span>
          </button>
          <Badge tone={event.kind === 'task' ? 'accent' : event.kind === 'quote_deadline' ? 'warm' : 'cold'}>
            {event.kind === 'quote_deadline' ? 'expiry' : label(event.type)}
          </Badge>
          {event.kind === 'task' && isOverdue(event.start) && <Badge tone="danger">overdue</Badge>}
          {event.kind === 'appointment' && isOverdue(event.start) && event.status === 'scheduled' && (
            <Button size="sm" onClick={() => onClose(event)}>Did it happen?</Button>
          )}
        </div>
      ))}
    </div>
  );
}

function buildRange(view: View, anchor: Date): { from: Date; to: Date; days: Date[] } {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);

  if (view === 'day') {
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { from: start, to: end, days: [start] };
  }

  if (view === 'week') {
    const monday = new Date(start);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
    const end = new Date(days[6]);
    end.setHours(23, 59, 59, 999);
    return { from: monday, to: end, days };
  }

  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const end = new Date(days[41]);
  end.setHours(23, 59, 59, 999);
  return { from: gridStart, to: end, days };
}

function rangeLabel(view: View, anchor: Date): string {
  if (view === 'day') return anchor.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (view === 'month') return anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const { days } = buildRange('week', anchor);
  return `${days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
