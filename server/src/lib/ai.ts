import Anthropic from '@anthropic-ai/sdk';
import { all, get, parseJson } from './db.ts';
import { config } from './config.ts';
import { notConfigured } from './errors.ts';
import { bumpUsage, countCompleteness } from './leads.ts';
import { projectSummary } from './render.ts';

/**
 * AI assistance is optional and always grounded in the lead's own record.
 * The system prompt forbids inventing technical specifications, prices,
 * savings, subsidies or legal claims — the model may only summarise and
 * suggest next steps from what the salesperson already recorded.
 */
const SYSTEM_PROMPT = `You assist salespeople at a solar PV and heat-pump installation company in Greece.

Ground every statement in the lead record you are given. Rules you must never break:
- Never invent or estimate technical specifications, system sizes, yields, energy savings, payback periods, prices, subsidies, grants, tariffs, permitting requirements or legal obligations. If the record does not contain a figure, say it is not recorded.
- Never promise anything to the customer. You write drafts for a salesperson to review and edit.
- Do not repeat the customer's personal data beyond what the salesperson needs.
- Be concise and specific. Prefer plain sentences over bullet lists unless asked.
- Write in the same language the lead record uses for names and notes; default to English.

You are an assistant, not the salesperson. Anything you draft will be reviewed before it is sent.`;

export interface AiClientResult {
  client: Anthropic;
  model: string;
  source: 'organization' | 'server';
}

export function getAiClient(orgId: string): AiClientResult {
  const row = get<{ status: string; secrets: string; config: string }>(
    "SELECT status, secrets, config FROM integrations WHERE org_id = ? AND provider = 'anthropic'",
    [orgId],
  );
  const secrets = parseJson<Record<string, string>>(row?.secrets, {});
  const orgConfig = parseJson<Record<string, string>>(row?.config, {});

  if (row?.status === 'connected' && secrets.api_key) {
    return {
      client: new Anthropic({ apiKey: secrets.api_key }),
      model: orgConfig.model || config.anthropicModel,
      source: 'organization',
    };
  }
  if (config.anthropicApiKey) {
    return {
      client: new Anthropic({ apiKey: config.anthropicApiKey }),
      model: config.anthropicModel,
      source: 'server',
    };
  }
  throw notConfigured(
    'AI assistance is not connected. Add an Anthropic API key in Settings → Communication to enable lead summaries and suggested replies.',
    { provider: 'anthropic' },
  );
}

export function isAiAvailable(orgId: string): boolean {
  try { getAiClient(orgId); return true; } catch { return false; }
}

/** Builds a compact, factual brief of a lead for the model to work from. */
export function buildLeadBrief(orgId: string, leadId: string): string {
  const lead = get<any>(
    `SELECT l.*, s.name AS source_name, st.name AS stage_name,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name,
            lr.name AS lost_reason_name
     FROM leads l
     LEFT JOIN lead_sources s ON s.id = l.source_id
     LEFT JOIN pipeline_stages st ON st.id = l.stage_id
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
     WHERE l.id = ? AND l.org_id = ?`,
    [leadId, orgId],
  );
  if (!lead) throw notConfigured('That lead no longer exists.');

  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === '' || value === 0) return;
    lines.push(`${label}: ${value}`);
  };

  lines.push('## Lead');
  push('Reference', lead.reference);
  push('Name', `${lead.first_name} ${lead.last_name}`);
  push('Company', lead.company);
  push('Location', [lead.city, lead.postal_code].filter(Boolean).join(' '));
  push('Source', lead.source_name);
  push('Campaign', lead.campaign);
  push('Owner', lead.owner_first_name ? `${lead.owner_first_name} ${lead.owner_last_name}` : null);
  push('Stage', lead.stage_name);
  push('Status', lead.status);
  push('Temperature', `${lead.temperature} (score ${lead.score}/100)`);
  push('Estimated value', `EUR ${Math.round(lead.estimated_value)}`);
  push('Probability', `${lead.probability}%`);
  push('Urgency', lead.urgency);
  push('Created', new Date(lead.created_at).toISOString().slice(0, 10));
  push('Last activity', lead.last_activity_at ? new Date(lead.last_activity_at).toISOString().slice(0, 10) : null);
  push('First contacted', lead.first_contacted_at ? new Date(lead.first_contacted_at).toISOString().slice(0, 10) : null);
  push('Lost reason', lead.lost_reason_name);
  push('Notes', lead.notes);

  lines.push('', '## Project interest');
  push('Interested in', projectSummary(lead));
  const pvFields: [string, unknown][] = [
    ['Desired system size (kWp)', lead.pv_desired_kwp],
    ['Annual consumption (kWh)', lead.pv_annual_kwh],
    ['Monthly electricity bill (EUR)', lead.pv_monthly_bill],
    ['Roof type', lead.pv_roof_type],
    ['Roof orientation', lead.pv_roof_orientation],
    ['Roof area (m2)', lead.pv_roof_area_m2],
    ['Shading', lead.pv_shading],
    ['Property type', lead.pv_property_type],
    ['Supply', lead.pv_phase],
    ['Grid connection', lead.pv_grid_connection],
    ['Existing PV system', lead.pv_existing_system ? 'yes' : null],
    ['Battery interest', lead.battery_interest ? `yes${lead.battery_kwh ? ` (${lead.battery_kwh} kWh)` : ''}` : null],
    ['EV charger interest', lead.ev_charger_interest ? `yes${lead.ev_charger_kw ? ` (${lead.ev_charger_kw} kW)` : ''}` : null],
    ['Backup power interest', lead.backup_power_interest ? 'yes' : null],
  ];
  const hpFields: [string, unknown][] = [
    ['Existing heating system', lead.hp_existing_system],
    ['Current fuel', lead.hp_current_fuel],
    ['Annual heating cost (EUR)', lead.hp_annual_heating_cost],
    ['Property type', lead.hp_property_type],
    ['Heated area (m2)', lead.hp_property_m2],
    ['Floors', lead.hp_floors],
    ['Emitters', lead.hp_emitters],
    ['Hot water required', lead.hp_dhw_required ? 'yes' : null],
    ['Cooling required', lead.hp_cooling_required ? 'yes' : null],
    ['Insulation', lead.hp_insulation],
    ['Estimated power (kW)', lead.hp_estimated_kw],
    ['Removal of old system', lead.hp_removal_required ? 'yes' : null],
  ];
  for (const [label, value] of [...pvFields, ...hpFields]) push(label, value);

  const activities = all<any>(
    `SELECT a.type, a.direction, a.title, a.body, a.outcome, a.occurred_at,
            u.first_name, u.last_name
     FROM activities a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.org_id = ? AND a.lead_id = ? ORDER BY a.occurred_at DESC LIMIT 40`,
    [orgId, leadId],
  );
  if (activities.length > 0) {
    lines.push('', '## Interaction history (most recent first)');
    for (const a of activities) {
      const who = a.first_name ? `${a.first_name}` : 'system';
      const dir = a.direction === 'inbound' ? 'customer' : a.direction === 'outbound' ? 'us' : 'internal';
      lines.push(
        `- ${new Date(a.occurred_at).toISOString().slice(0, 16).replace('T', ' ')} [${a.type}/${dir}/${who}] ${a.title}`
        + (a.outcome ? ` (outcome: ${a.outcome})` : '')
        + (a.body ? `\n  ${String(a.body).replace(/\s+/g, ' ').slice(0, 400)}` : ''),
      );
    }
  }

  const quotes = all<any>(
    `SELECT number, title, status, total, currency, sent_at, valid_until, responded_at
     FROM quotations WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 5`,
    [orgId, leadId],
  );
  if (quotes.length > 0) {
    lines.push('', '## Quotations');
    for (const q of quotes) {
      lines.push(
        `- ${q.number} "${q.title}": ${q.status}, ${q.currency} ${q.total}`
        + (q.sent_at ? `, sent ${new Date(q.sent_at).toISOString().slice(0, 10)}` : '')
        + (q.valid_until ? `, valid until ${new Date(q.valid_until).toISOString().slice(0, 10)}` : ''),
      );
    }
  }

  const tasks = all<any>(
    "SELECT title, due_at, priority FROM tasks WHERE org_id = ? AND lead_id = ? AND status = 'open' ORDER BY due_at LIMIT 5",
    [orgId, leadId],
  );
  if (tasks.length > 0) {
    lines.push('', '## Open follow-ups');
    for (const t of tasks) {
      lines.push(`- ${t.title}${t.due_at ? ` (due ${new Date(t.due_at).toISOString().slice(0, 16).replace('T', ' ')})` : ''} [${t.priority}]`);
    }
  } else {
    lines.push('', '## Open follow-ups', '- none scheduled');
  }

  const surveys = all<any>(
    "SELECT status, completed_at, recommended_system, technical_notes, blockers, feasible FROM site_surveys WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 3",
    [orgId, leadId],
  );
  if (surveys.length > 0) {
    lines.push('', '## Site surveys');
    for (const s of surveys) {
      lines.push(
        `- ${s.status}${s.completed_at ? ` on ${new Date(s.completed_at).toISOString().slice(0, 10)}` : ''}`
        + (s.feasible === 0 ? ' — marked NOT feasible' : s.feasible === 1 ? ' — feasible' : '')
        + (s.recommended_system ? `\n  recommended: ${s.recommended_system}` : '')
        + (s.technical_notes ? `\n  notes: ${String(s.technical_notes).slice(0, 400)}` : '')
        + (s.blockers ? `\n  blockers: ${s.blockers}` : ''),
      );
    }
  }

  const missing = countCompleteness(lead).missing;
  lines.push('', '## Information not recorded');
  lines.push(missing.length > 0 ? missing.map((m) => `- ${m}`).join('\n') : '- nothing material is missing');

  return lines.join('\n');
}

export type AiTask = 'summary' | 'next_action' | 'reply' | 'qualification' | 'conversation';

const TASK_PROMPTS: Record<AiTask, (extra?: string) => string> = {
  summary: () =>
    'Write a 3-5 sentence brief of this lead for the salesperson: what the customer wants, the technical facts that are recorded, where the deal stands and the customer\'s main concern if one is evident from the history. Plain prose, no headings, no bullet points.',
  conversation: () =>
    'Summarise the interaction history: what has been discussed, what the customer asked for, what we promised, and what is still unanswered. Keep it under 150 words.',
  next_action: () =>
    'Recommend the single best next action for the salesperson. State what to do, why (citing what is in the record), and when. Two or three sentences. If the lead is stalled, say what specifically is blocking it. Do not recommend anything that requires a fact the record does not contain.',
  reply: (extra) =>
    `Draft a short message the salesperson can send to this customer${extra ? ` about: ${extra}` : ''}. Keep it under 120 words, friendly and professional, no pricing or technical figures unless they already appear in the record. Sign off with the salesperson's first name as a placeholder in square brackets. Return only the message text.`,
  qualification: () =>
    'List exactly what information is still missing before this lead can be quoted accurately, and for each item give the one question the salesperson should ask to get it. Use a short bullet list. Use only the "Information not recorded" section plus anything obviously absent from the record.',
};

export interface AiResult {
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export async function runAiTask(
  orgId: string, leadId: string, task: AiTask, extra?: string,
): Promise<AiResult> {
  const { client, model } = getAiClient(orgId);
  const brief = buildLeadBrief(orgId, leadId);

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    // These are short summarisation/extraction tasks; low effort keeps them
    // fast and cheap while thinking stays on by default.
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: `Here is the lead record.\n\n${brief}\n\n---\n\n${TASK_PROMPTS[task](extra)}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw notConfigured('The AI assistant declined to answer this request. Try rephrasing it.');
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  bumpUsage(orgId, 'ai_calls');
  return {
    text,
    model: response.model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
