import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { ErrorBlock, LoadingBlock, Modal } from './ui';
import AppointmentDialog from './AppointmentDialog';

/**
 * The booking dialog, opened from somewhere that only knows the lead's id — the
 * dashboard's "Schedule installation", for instance. Loads the lead through the
 * normal endpoint so tenancy and the owner check apply as everywhere else.
 */
export default function LeadAppointmentDialog({
  leadId, defaultType, onClose, onSaved,
}: {
  leadId: string;
  defaultType?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => get(`/leads/${leadId}`),
  });

  if (isLoading) return <Modal title="Loading…" onClose={onClose}><LoadingBlock rows={3} /></Modal>;
  if (error || !data?.lead) {
    return <Modal title="Could not open" onClose={onClose}><ErrorBlock error={error} /></Modal>;
  }
  return (
    <AppointmentDialog lead={data.lead} defaultType={defaultType} onClose={onClose} onSaved={onSaved} />
  );
}
