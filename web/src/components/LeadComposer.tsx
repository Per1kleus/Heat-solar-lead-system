import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { Modal, LoadingBlock, ErrorBlock } from './ui';
import MessageComposer, { type ComposerChannel } from './MessageComposer';

/**
 * The message composer, opened from somewhere that only knows the lead's id —
 * the dashboard, for instance. Loads the lead through the normal endpoint (so
 * tenancy and the owner check apply exactly as everywhere else) and then hands
 * over to the one composer.
 */
export default function LeadComposer({
  leadId, channel, templateKey, quotationId, appointmentId, onClose, onSent,
}: {
  leadId: string;
  channel: ComposerChannel;
  templateKey?: string;
  quotationId?: string;
  appointmentId?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => get(`/leads/${leadId}`),
  });

  if (isLoading) {
    return <Modal title="Loading…" onClose={onClose}><LoadingBlock rows={3} /></Modal>;
  }
  if (error || !data?.lead) {
    return <Modal title="Could not open" onClose={onClose}><ErrorBlock error={error} /></Modal>;
  }
  // A contact with no phone starts on email instead of a dead WhatsApp tab.
  const start: ComposerChannel = channel === 'whatsapp' && !data.lead.phone ? 'email' : channel;
  return (
    <MessageComposer
      lead={data.lead}
      channel={start}
      templateKey={templateKey}
      quotationId={quotationId}
      appointmentId={appointmentId}
      onClose={onClose}
      onSent={onSent}
    />
  );
}
