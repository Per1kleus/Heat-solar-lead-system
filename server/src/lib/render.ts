import { parseJson } from './db.ts';
import { money } from './leads.ts';

// --- template rendering ---------------------------------------------------

/** Replaces {{lead.x}} / {{quote.x}} / {{company.x}} placeholders. Unknown keys render empty. */
export function render(template: string, ctx: Record<string, any>): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([a-z_]+)\.([a-z_]+)\s*\}\}/gi, (_match, scope: string, key: string) => {
    const value = resolvePlaceholder(scope.toLowerCase(), key.toLowerCase(), ctx);
    return value === null || value === undefined ? '' : String(value);
  });
}

function resolvePlaceholder(scope: string, key: string, ctx: any): unknown {
  const lead = ctx.lead;
  const quote = ctx.quotation ?? ctx.quote;
  const org = ctx.org ?? ctx.company;
  const task = ctx.task;
  const user = ctx.user;
  switch (scope) {
    case 'lead':
      if (!lead) return '';
      if (key === 'full_name') return `${lead.first_name} ${lead.last_name}`.trim();
      if (key === 'value') return money(lead.estimated_value, org?.currency ?? 'EUR');
      if (key === 'project_summary') return projectSummary(lead);
      return lead[key];
    case 'quote':
      if (!quote) return '';
      if (key === 'total') return money(quote.total, org?.currency ?? 'EUR');
      if (key === 'valid_until') {
        return quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('en-GB') : '';
      }
      return quote[key];
    case 'company':
      return org?.[key];
    case 'task':
      if (!task) return '';
      if (key === 'due_human') return task.due_at ? new Date(task.due_at).toLocaleString('en-GB') : 'with no due date';
      return task[key];
    case 'user':
      return user?.[key];
    case 'appointment':
      if (key === 'date' && ctx.appointment?.starts_at) {
        return new Date(ctx.appointment.starts_at).toLocaleString('en-GB');
      }
      return ctx.appointment?.[key];
    default:
      return '';
  }
}

const TYPE_LABELS: Record<string, string> = {
  pv: 'a photovoltaic system', heat_pump: 'a heat pump', battery: 'battery storage',
  ev_charger: 'an EV charger', other: 'an energy project',
};

export function projectSummary(lead: any): string {
  const types: string[] = Array.isArray(lead.project_types)
    ? lead.project_types
    : parseJson<string[]>(lead.project_types, []);
  const parts = types.map((t) => TYPE_LABELS[t] ?? t);
  if (lead.pv_desired_kwp && types.includes('pv')) {
    parts[parts.indexOf(TYPE_LABELS.pv)] = `a ${lead.pv_desired_kwp} kWp photovoltaic system`;
  }
  if (lead.hp_estimated_kw && types.includes('heat_pump')) {
    const idx = parts.indexOf(TYPE_LABELS.heat_pump);
    if (idx >= 0) parts[idx] = `a ${lead.hp_estimated_kw} kW heat pump`;
  }
  if (parts.length === 0) return 'your energy project';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
