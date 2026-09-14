import { useState } from 'react';
import { patch } from '../lib/api';
import { Button, Icon, Modal, useToast } from './ui';
import { dateTime, toInputDateTime, fromInputDateTime } from '../lib/format';

type Outcome = 'completed' | 'no_show' | 'cancelled' | 'reschedule';

/**
 * Closing off a visit: it happened, it did not, it moved, or it is off. Kept in
 * one component so the dashboard, the calendar and the lead page all offer the
 * same four answers and record them the same way.
 */
export default function AppointmentOutcome({
  appointment, onClose, onSaved,
}: {
  appointment: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>('completed');
  const [note, setNote] = useState('');
  const [startsAt, setStartsAt] = useState(() => toInputDateTime(appointment.starts_at));
  const [notify, setNotify] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { outcome_note: note || undefined };
      if (outcome === 'reschedule') {
        payload.starts_at = fromInputDateTime(startsAt);
        payload.status = 'scheduled';
        payload.allow_conflict = true;
      } else {
        payload.status = outcome;
      }
      if (notify && (outcome === 'reschedule' || outcome === 'cancelled')) payload.notify_customer = true;
      const result = await patch(`/appointments/${appointment.id}`, payload);

      const notification = result?.notification;
      if (notification && !notification.sent) {
        toast.show(`Saved, but the customer was NOT told: ${notification.reason}`, 'error');
      } else if (notification?.sent) {
        toast.success('Saved and the customer was told.', `Sent by ${notification.channel}.`);
      } else {
        toast.success(OUTCOME_TOAST[outcome]);
      }
      onSaved(); onClose();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={appointment.title}
      subtitle={`Booked for ${dateTime(appointment.starts_at)}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>Save</Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="field">
          <label>What happened?</label>
          <div className="chips">
            {([
              ['completed', 'It happened'],
              ['no_show', 'Customer was not there'],
              ['reschedule', 'Move it'],
              ['cancelled', 'Cancel it'],
            ] as [Outcome, string][]).map(([key, text]) => (
              <button
                key={key} type="button"
                className={`chip ${outcome === key ? 'on' : ''}`}
                onClick={() => setOutcome(key)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        {outcome === 'reschedule' && (
          <div className="field">
            <label>New date and time</label>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
        )}

        {(outcome === 'reschedule' || outcome === 'cancelled') && (
          <label className="check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>Tell the customer</span>
          </label>
        )}

        <div className="field">
          <label>Note {outcome === 'no_show' ? '' : '(optional)'}</label>
          <textarea
            rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={outcome === 'completed' ? 'What was agreed on site?' : 'What happened?'}
          />
        </div>

        {outcome === 'no_show' && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <span>The lead stays open. Give it a next action so it does not get forgotten.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

const OUTCOME_TOAST: Record<Outcome, string> = {
  completed: 'Appointment marked as completed.',
  no_show: 'Recorded as missed.',
  reschedule: 'Appointment moved.',
  cancelled: 'Appointment cancelled.',
};
