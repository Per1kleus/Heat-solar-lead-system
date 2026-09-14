/**
 * Tiny in-process event bus. Domain services (leads, quotations, tasks) emit
 * events; the automation engine subscribes. Keeps the engine out of the domain
 * modules' import graph so neither depends on the other.
 */
export type DomainEvent =
  | { type: 'lead_created'; orgId: string; leadId: string; userId?: string | null }
  | { type: 'lead_assigned'; orgId: string; leadId: string; ownerId: string; byUserId?: string | null }
  | { type: 'stage_changed'; orgId: string; leadId: string; fromStage: string | null; toStage: string; userId?: string | null }
  | { type: 'temperature_changed'; orgId: string; leadId: string; from: string; to: string }
  | { type: 'lead_won'; orgId: string; leadId: string; userId?: string | null }
  | { type: 'lead_lost'; orgId: string; leadId: string; userId?: string | null }
  | { type: 'lead_contacted'; orgId: string; leadId: string }
  | { type: 'customer_replied'; orgId: string; leadId: string }
  | { type: 'quote_sent'; orgId: string; leadId: string | null; quotationId: string; userId?: string | null }
  | { type: 'quote_responded'; orgId: string; leadId: string | null; quotationId: string; status: string }
  | { type: 'appointment_booked'; orgId: string; leadId: string | null; appointmentId: string }
  | { type: 'appointment_reminder_due'; orgId: string; leadId: string | null; appointmentId: string }
  | { type: 'appointment_cancelled'; orgId: string; leadId: string | null; appointmentId: string }
  | { type: 'appointment_missed'; orgId: string; leadId: string | null; appointmentId: string }
  | { type: 'installation_completed'; orgId: string; leadId: string | null; projectId: string }
  | { type: 'task_overdue'; orgId: string; taskId: string; leadId: string | null }
  | { type: 'lead_idle'; orgId: string; leadId: string }
  | { type: 'no_next_action'; orgId: string; leadId: string };

type Handler = (event: DomainEvent) => void;

const handlers: Handler[] = [];

export function onDomainEvent(handler: Handler): void {
  handlers.push(handler);
}

export function emit(event: DomainEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      // An automation failure must never roll back the user's action.
      console.error(`[events] handler failed for ${event.type}:`, err);
    }
  }
}
