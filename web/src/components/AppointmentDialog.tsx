import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { Button, Icon, Modal, useToast } from './ui';
import { dateTime, toInputDateTime, fromInputDateTime } from '../lib/format';

/** The name a visit gets by default, per kind. */
function titleFor(type: string, lead: any): string {
  const who = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim();
  return ({
    site_survey: `Site survey — ${who}`,
    sales_meeting: `Meeting — ${who}`,
    call: `Call — ${who}`,
    installation: `Installation — ${who}`,
    service: `Service visit — ${who}`,
  } as Record<string, string>)[type] ?? `Appointment — ${who}`;
}

/**
 * Books a visit against a lead. One implementation, used from the lead page and
 * from the dashboard's "Schedule installation" action, so the conflict handling
 * and the customer confirmation behave identically wherever it is opened.
 */
export default function AppointmentDialog({
  lead, defaultType = 'site_survey', onClose, onSaved,
}: {
  lead: any;
  /** Opens ready for this kind of visit — "Schedule installation" passes 'installation'. */
  defaultType?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState(defaultType);
  const [title, setTitle] = useState(() => titleFor(defaultType, lead));
  const [startsAt, setStartsAt] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(10, 0, 0, 0);
    return toInputDateTime(d.toISOString());
  });
  const [durationMin, setDurationMin] = useState(defaultType === 'installation' ? 480 : 60);
  const [technicianId, setTechnicianId] = useState('');
  const [location, setLocation] = useState([lead.address, lead.city].filter(Boolean).join(', '));
  const [description, setDescription] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflicts, setConflicts] = useState<any[] | null>(null);
  const toast = useToast();

  const { data: users } = useQuery({ queryKey: ['users-light'], queryFn: () => get('/settings/users'), staleTime: 300_000 });
  const technicians = (users?.users ?? []).filter((u: any) => u.status === 'active');
  const { data: channelData } = useQuery({
    queryKey: ['channels', lead.id],
    queryFn: () => get(`/messages/channels?lead_id=${lead.id}`),
    staleTime: 60_000,
  });
  const canMessage = (channelData?.channels ?? []).some(
    (c: any) => ['email', 'whatsapp'].includes(c.key) && c.connected && c.reachable,
  );


  /** `force` books over a clash the user has now seen. */
  const book = async (force = false) => {
    setSaving(true);
    try {
      const starts = fromInputDateTime(startsAt);
      if (!starts) { toast.show('Choose a valid date and time.', 'error'); setSaving(false); return; }
      const result = await post('/appointments', {
        lead_id: lead.id, type, title,
        starts_at: starts,
        ends_at: new Date(new Date(starts).getTime() + durationMin * 60_000).toISOString(),
        technician_id: technicianId || undefined,
        location: location || undefined,
        description: description || undefined,
        notify_customer: notifyCustomer && canMessage,
        allow_conflict: force,
      });
      const notification = result?.notification;
      if (notification && !notification.sent) {
        // Booked, but be explicit that the customer was not told.
        toast.show(`Booked. The customer was NOT told: ${notification.reason}`, 'error');
      } else if (notification?.sent) {
        toast.success('Appointment booked.', `Confirmation sent by ${notification.channel}.`);
      } else {
        toast.success('Appointment booked.');
      }
      onSaved(); onClose();
    } catch (err: any) {
      if (err?.details?.conflicts) setConflicts(err.details.conflicts);
      else toast.error(err);
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title="Book an appointment" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          {conflicts && (
            <Button loading={saving} onClick={() => book(true)}>Book anyway</Button>
          )}
          <Button variant="primary" loading={saving} disabled={!title.trim()} onClick={() => book(false)}>
            Book
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        {conflicts && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <div className="grow">
              <strong>That slot is already taken.</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {conflicts.map((c: any) => (
                  <li key={c.id} className="small">{c.user_name} — {c.title}, {dateTime(c.starts_at)}</li>
                ))}
              </ul>
              <div className="small">Pick another time, choose someone else, or book it anyway.</div>
            </div>
          </div>
        )}

        <div className="grid c2">
          <div className="field">
            <label>Type</label>
            <select
              value={type}
              onChange={(e) => { setType(e.target.value); setTitle(titleFor(e.target.value, lead)); setConflicts(null); }}
            >
              <option value="site_survey">Technical site survey</option>
              <option value="sales_meeting">Sales meeting</option>
              <option value="call">Scheduled call</option>
              <option value="installation">Installation</option>
              <option value="service">Service visit</option>
            </select>
          </div>
          <div className="field">
            <label>Date and time</label>
            <input
              type="datetime-local" value={startsAt}
              onChange={(e) => { setStartsAt(e.target.value); setConflicts(null); }}
            />
          </div>
        </div>
        <div className="grid c2">
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>How long?</label>
            <select value={durationMin} onChange={(e) => { setDurationMin(Number(e.target.value)); setConflicts(null); }}>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={90}>1½ hours</option>
              <option value={120}>2 hours</option>
              <option value={240}>Half a day</option>
              <option value={480}>A full day</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Address</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        <div className="field">
          <label>Who is going?</label>
          <select
            value={technicianId}
            onChange={(e) => { setTechnicianId(e.target.value); setConflicts(null); }}
          >
            <option value="">Assign later</option>
            {technicians.map((u: any) => <option key={u.id} value={u.id}>{u.full_name} ({u.role_label})</option>)}
          </select>
          <span className="hint">A site survey with a technician creates the on-site checklist automatically.</span>
        </div>
        <div className="field">
          <label>Notes for whoever attends (optional)</label>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <label className="check">
          <input
            type="checkbox" checked={notifyCustomer && canMessage} disabled={!canMessage}
            onChange={(e) => setNotifyCustomer(e.target.checked)}
          />
          <span>
            Send {lead.first_name} a confirmation
            {!canMessage && <span className="dim"> — no channel is connected, so nothing can be sent yet</span>}
          </span>
        </label>
      </div>
    </Modal>
  );
}
