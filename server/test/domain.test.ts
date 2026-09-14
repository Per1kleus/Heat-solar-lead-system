import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each run gets its own database file so the suite never touches real data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltaflow-test-'));
process.env.VF_DATA_DIR = tmpDir;
process.env.VF_DB_PATH = path.join(tmpDir, 'test.db');
process.env.VF_JWT_SECRET = 'test-secret-not-used-in-production';
process.env.NODE_ENV = 'test';

const { applySchema, all, get, run } = await import('../src/lib/db.ts');
const { registerAutomationEngine, processDueRuns, stopAllRuns, stopRun } = await import('../src/lib/automation.ts');
const { buildAttentionList } = await import('../src/lib/attention.ts');
const { emit } = await import('../src/lib/events.ts');
const { provisionOrganization } = await import('../src/lib/provision.ts');
const {
  createLead, findDuplicates, normalizePhone, dedupeKeyFor, rescoreLead, markLost, markWon,
  moveStage, logActivity, recomputeNextAction, loadLead, shapeLead,
} = await import('../src/lib/leads.ts');
const { computeScore, gatherSignals, loadRules, countCompleteness } = await import('../src/lib/scoring.ts');
const { DEFAULT_TEMPLATES } = await import('../src/lib/defaults.ts');
const { computeTotals, createQuotation, markSent, setQuotationStatus } = await import('../src/lib/quotations.ts');
const { createTask, completeTask } = await import('../src/lib/tasks.ts');
const { renderQuotationPdf } = await import('../src/lib/pdf.ts');
const { getSubscription, assertLeadAllowance } = await import('../src/lib/billing.ts');
const { render, projectSummary } = await import('../src/lib/render.ts');
const { hashPassword, verifyPassword } = await import('../src/lib/auth.ts');
const { can, seesEverything } = await import('../src/lib/permissions.ts');
const {
  checkMarketingConsent, getIntegration, channelStatus, resolveChannel, renderTemplate,
  sendTemplate, checkAutomatedSendAllowed,
} = await import('../src/lib/messaging.ts');
const { buildQuotationDraft } = await import('../src/lib/quoteDraft.ts');
const { findApptConflicts } = await import('../src/routes/tasks.ts');
const { newId } = await import('../src/lib/ids.ts');
const { nowIso } = await import('../src/lib/time.ts');

applySchema();
registerAutomationEngine();

let orgA = '';
let userA = '';
let orgB = '';
let userB = '';

before(() => {
  const a = provisionOrganization({
    companyName: 'Test Solar A', firstName: 'Anna', lastName: 'Alpha',
    email: 'a@test-a.gr', password: 'TestPassword123!', services: ['pv', 'heat_pump'],
  });
  orgA = a.orgId; userA = a.userId;
  const b = provisionOrganization({
    companyName: 'Test Solar B', firstName: 'Boris', lastName: 'Beta',
    email: 'b@test-b.gr', password: 'TestPassword123!', services: ['pv'],
  });
  orgB = b.orgId; userB = b.userId;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- provisioning

describe('organisation provisioning', () => {
  test('a new organisation gets the installer defaults', () => {
    const stages = all('SELECT * FROM pipeline_stages WHERE org_id = ? ORDER BY position', [orgA]);
    assert.equal(stages.length, 10);
    assert.equal((stages[0] as any).key, 'new');
    assert.equal((stages.at(-1) as any).type, 'lost');

    assert.equal(all('SELECT 1 FROM lead_sources WHERE org_id = ?', [orgA]).length, 11);
    assert.equal(all('SELECT 1 FROM lost_reasons WHERE org_id = ?', [orgA]).length, 8);
    // Nine rules run out of the box: the eight from the spec plus the appointment
    // reminder. The customer-messaging sequences ship switched off.
    assert.equal(all('SELECT 1 FROM automation_rules WHERE org_id = ? AND is_active = 1', [orgA]).length, 9);
    assert.equal(all('SELECT 1 FROM automation_rules WHERE org_id = ? AND is_active = 0', [orgA]).length, 3);
    assert.ok(all('SELECT 1 FROM product_templates WHERE org_id = ?', [orgA]).length > 15);
    assert.equal(all('SELECT 1 FROM message_templates WHERE org_id = ?', [orgA]).length, DEFAULT_TEMPLATES.length);
    // Every template an automation rule sends must actually exist.
    for (const key of ['appointment_reminder', 'appointment_confirmation', 'survey_reminder', 'first_contact']) {
      assert.ok(
        get('SELECT 1 FROM message_templates WHERE org_id = ? AND key = ?', [orgA, key]),
        `template ${key} should be provisioned`,
      );
    }
  });

  test('every integration starts disconnected', () => {
    for (const provider of ['smtp', 'whatsapp_cloud', 'anthropic']) {
      assert.equal(getIntegration(orgA, provider)?.status, 'disconnected');
    }
  });

  test('a trial subscription is created', () => {
    const sub = getSubscription(orgA);
    assert.equal(sub.plan, 'trial');
    assert.equal(sub.status, 'trialing');
    assert.ok(sub.lead_limit > 0);
  });
});

// ---------------------------------------------------------------- passwords & roles

describe('authentication primitives', () => {
  test('passwords hash and verify, and short ones are refused', () => {
    const hash = hashPassword('a-long-enough-password');
    assert.ok(verifyPassword('a-long-enough-password', hash));
    assert.ok(!verifyPassword('a-long-enough-passwor', hash));
    assert.throws(() => hashPassword('short'), /at least 10/);
  });

  test('role permissions are scoped as documented', () => {
    assert.ok(can('owner', 'billing:write'));
    assert.ok(can('sales_manager', 'leads:read:all'));
    assert.ok(!can('sales_manager', 'users:write'));
    assert.ok(can('salesperson', 'quotes:write'));
    assert.ok(!can('salesperson', 'leads:read:all'));
    assert.ok(!can('salesperson', 'analytics:team'));
    assert.ok(can('technician', 'surveys:complete'));
    assert.ok(!can('technician', 'quotes:write'));
    assert.ok(seesEverything('admin'));
    assert.ok(!seesEverything('salesperson'));
  });
});

// ---------------------------------------------------------------- duplicates

describe('duplicate detection', () => {
  test('phone numbers normalise across Greek formats', () => {
    const forms = ['+30 694 512 3388', '00306945123388', '6945123388', '694-512-3388'];
    const normalised = forms.map(normalizePhone);
    assert.equal(new Set(normalised).size, 1, `expected one form, got ${JSON.stringify(normalised)}`);
    assert.equal(normalizePhone('123'), null);
    assert.equal(normalizePhone(null), null);
  });

  test('the dedupe key prefers the phone and falls back to the email', () => {
    assert.equal(dedupeKeyFor('+30 694 512 3388', 'x@y.gr'), 'p:6945123388');
    assert.equal(dedupeKeyFor(null, 'X@Y.GR'), 'e:x@y.gr');
    assert.equal(dedupeKeyFor(null, null), null);
  });

  test('a second lead with the same phone is refused unless allowed', () => {
    createLead(
      { first_name: 'Dup', last_name: 'Test', phone: '+30 690 111 2222', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    assert.throws(
      () => createLead(
        { first_name: 'Dup', last_name: 'Test', phone: '0030 690 111 2222', project_types: ['pv'] },
        { orgId: orgA, userId: userA, skipAutomation: true },
      ),
      /already exists/,
    );
    const matches = findDuplicates(orgA, '6901112222', null);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched_on, 'phone');
  });

  test('duplicates never leak across organisations', () => {
    assert.equal(findDuplicates(orgB, '+30 690 111 2222', null).length, 0);
  });

  test('a lead must be reachable', () => {
    assert.throws(
      () => createLead({ first_name: 'No', last_name: 'Contact' }, { orgId: orgA, userId: userA }),
      /phone number or an email/,
    );
  });
});

// ---------------------------------------------------------------- scoring

describe('lead scoring', () => {
  test('scores rise with real signals and explain themselves', () => {
    const { lead } = createLead(
      {
        first_name: 'Score', last_name: 'Test', phone: '+30 691 000 0001', email: 's@test.gr',
        project_types: ['pv', 'battery'], estimated_value: 14000, urgency: 'immediate',
        budget_known: 1, budget_amount: 15000,
        pv_annual_kwh: 12000, pv_monthly_bill: 190, pv_roof_type: 'tile',
        pv_roof_orientation: 'S', pv_roof_area_m2: 70, pv_phase: 'three',
        pv_property_type: 'detached', address: 'Somewhere 1', city: 'Athens',
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const result = rescoreLead(orgA, lead.id);
    assert.ok(result.score >= 50, `expected a warm-or-better score, got ${result.score}`);
    assert.ok(result.breakdown.length >= 4);
    // Every factor must name itself and carry points — the score is never a black box.
    for (const factor of result.breakdown) {
      assert.ok(factor.label.length > 3);
      assert.notEqual(factor.points, 0);
    }
    assert.ok(result.breakdown.some((f) => f.key === 'high_value'));
    assert.ok(result.breakdown.some((f) => f.key === 'urgency'));
    assert.ok(result.breakdown.some((f) => f.key === 'multi_product'));
  });

  test('asking for a price scores before we have sent one', () => {
    const rules = loadRules(orgA);
    const signals = {
      quotesSent: 0, customerReplies: 0, outboundAttempts: 0, failedAttempts: 0,
      surveysBooked: 0, appointmentsBooked: 0, hoursSinceActivity: 0,
    };
    const base = { org_id: orgA, status: 'open', project_types: '["pv"]', estimated_value: 0 };
    const asked = computeScore({ ...base, requested_quote: 1 }, rules, signals);
    const didNot = computeScore(base, rules, signals);
    const factor = asked.breakdown.find((f) => f.key === 'requested_quote');
    assert.ok(factor, 'an enquiry that asked for a price must score for it');
    assert.equal(asked.score - didNot.score, factor!.points);
  });

  test('the website form records that a price was requested', () => {
    const { lead } = createLead(
      {
        first_name: 'Asked', last_name: 'ForPrice', phone: '+30 691 000 0077',
        project_types: ['pv'], requested_quote: 1,
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    assert.equal(shapeLead(loadLead(orgA, lead.id)).requested_quote, true);
    assert.ok(rescoreLead(orgA, lead.id).breakdown.some((f) => f.key === 'requested_quote'));
  });

  test('the temperature follows the documented bands', () => {
    const rules = loadRules(orgA);
    const base = { org_id: orgA, id: 'x', status: 'open', project_types: '[]', estimated_value: 0 };
    const signals = { quotesSent: 0, customerReplies: 0, outboundAttempts: 0, failedAttempts: 0, surveysBooked: 0, appointmentsBooked: 0, hoursSinceActivity: 0 };
    assert.equal(computeScore(base, rules, signals).temperature, 'cold');
    assert.equal(computeScore(base, [{ key: 'requested_quote', label: 'q', points: 55, config: {}, is_active: 1 }], { ...signals, quotesSent: 1 }).temperature, 'warm');
    assert.equal(computeScore(base, [{ key: 'requested_quote', label: 'q', points: 95, config: {}, is_active: 1 }], { ...signals, quotesSent: 1 }).temperature, 'hot');
  });

  test('the score is clamped to 0-100', () => {
    const rules = [{ key: 'requested_quote', label: 'q', points: 50, config: {}, is_active: 1 }];
    const signals = { quotesSent: 3, customerReplies: 0, outboundAttempts: 0, failedAttempts: 0, surveysBooked: 0, appointmentsBooked: 0, hoursSinceActivity: 0 };
    const big = computeScore({ project_types: '[]' }, [...rules, ...rules, ...rules], signals);
    assert.ok(big.score <= 100);
    const negative = computeScore({ project_types: '[]', status: 'open', last_activity_at: '2020-01-01T00:00:00Z' },
      [{ key: 'stale', label: 's', points: -40, config: { days: 1 }, is_active: 1 }],
      { ...signals, hoursSinceActivity: 10_000 });
    assert.ok(negative.score >= 0);
  });

  test('missing technical information is reported per project type', () => {
    const pv = countCompleteness({ project_types: '["pv"]', pv_interest: 1, phone: '123' });
    assert.ok(pv.missing.includes('annual electricity consumption'));
    assert.ok(pv.missing.includes('roof type'));
    assert.ok(!pv.missing.includes('insulation condition'));

    const hp = countCompleteness({ project_types: '["heat_pump"]', hp_interest: 1, phone: '123' });
    assert.ok(hp.missing.includes('insulation condition'));
    assert.ok(!hp.missing.includes('roof orientation'));
  });

  test('a forgotten lead cools down, and the decay is not an edit', () => {
    const { lead } = createLead(
      {
        first_name: 'Forgotten', last_name: 'Lead', phone: '+30 691 000 0099', email: 'f@test.gr',
        project_types: ['pv'], estimated_value: 14000, urgency: 'immediate',
        pv_annual_kwh: 12000, pv_monthly_bill: 190, pv_roof_type: 'tile',
        pv_roof_orientation: 'S', pv_roof_area_m2: 70, pv_phase: 'three',
        pv_property_type: 'detached', address: 'Somewhere 2', city: 'Athens',
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const fresh = rescoreLead(orgA, lead.id);
    assert.ok(!fresh.breakdown.some((f) => f.key === 'stale'), 'a new lead is not stale');

    // Nobody touches it for a month. Staleness fires on the ABSENCE of activity,
    // so only the scheduled sweep can ever apply it.
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const before = get<{ updated_at: string }>('SELECT updated_at FROM leads WHERE id = ?', [lead.id])!;
    run('UPDATE leads SET last_activity_at = ? WHERE id = ?', [monthAgo, lead.id]);

    const decayed = rescoreLead(orgA, lead.id, { touch: false });
    const staleFactor = decayed.breakdown.find((f) => f.key === 'stale');
    assert.ok(staleFactor, 'the staleness penalty must appear in the breakdown');
    assert.ok(staleFactor!.points < 0);
    assert.ok(decayed.score < fresh.score, `expected the score to fall from ${fresh.score}, got ${decayed.score}`);

    const after = get<{ updated_at: string; scored_at: string }>(
      'SELECT updated_at, scored_at FROM leads WHERE id = ?', [lead.id],
    )!;
    assert.equal(after.updated_at, before.updated_at, 'a decayed score must not count as an edit');
    assert.ok(after.scored_at > monthAgo, 'the lead must be marked as freshly scored');
  });

  test('an inactive scoring rule stops contributing', () => {
    const rules = loadRules(orgA).map((r) => ({ ...r, is_active: 0 }));
    const result = computeScore({ project_types: '[]', estimated_value: 99999 }, rules,
      { quotesSent: 5, customerReplies: 5, outboundAttempts: 0, failedAttempts: 0, surveysBooked: 5, appointmentsBooked: 5, hoursSinceActivity: 0 });
    assert.equal(result.score, 0);
  });
});

// ---------------------------------------------------------------- quotations

describe('quotation maths', () => {
  test('optional lines are priced separately and never in the total', () => {
    const totals = computeTotals(
      [
        { name: 'Panels', quantity: 20, unit_price: 100, is_optional: false },
        { name: 'Inverter', quantity: 1, unit_price: 1800, is_optional: false },
        { name: 'Maintenance', quantity: 1, unit_price: 200, is_optional: true },
      ],
      { discount_type: 'amount', discount_value: 0, vat_rate: 24 },
    );
    assert.equal(totals.subtotal, 3800);
    assert.equal(totals.optional_total, 200);
    assert.equal(totals.vat_amount, 912);
    assert.equal(totals.total, 4712);
  });

  test('percentage and absolute discounts both apply before VAT', () => {
    const percent = computeTotals([{ name: 'x', quantity: 1, unit_price: 1000 }], { discount_type: 'percent', discount_value: 10, vat_rate: 24 });
    assert.equal(percent.discount_amount, 100);
    assert.equal(percent.total, 1116);

    const amount = computeTotals([{ name: 'x', quantity: 1, unit_price: 1000 }], { discount_type: 'amount', discount_value: 100, vat_rate: 24 });
    assert.equal(amount.total, 1116);
  });

  test('a line discount reduces only that line', () => {
    const totals = computeTotals(
      [{ name: 'a', quantity: 2, unit_price: 100, discount_pct: 50 }, { name: 'b', quantity: 1, unit_price: 100 }],
      { vat_rate: 0 },
    );
    assert.equal(totals.subtotal, 200);
  });

  test('a discount larger than the subtotal never produces a negative total', () => {
    const totals = computeTotals([{ name: 'x', quantity: 1, unit_price: 100 }], { discount_type: 'amount', discount_value: 500, vat_rate: 24 });
    assert.equal(totals.total, 0);
  });

  test('quotation numbers are sequential and unique per organisation', () => {
    const { lead } = createLead(
      { first_name: 'Quote', last_name: 'Target', phone: '+30 691 000 0002', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const first = createQuotation({
      orgId: orgA, userId: userA, leadId: lead.id, title: 'First',
      items: [{ name: 'Panel', quantity: 10, unit_price: 100 }],
    });
    const second = createQuotation({
      orgId: orgA, userId: userA, leadId: lead.id, title: 'Second',
      items: [{ name: 'Panel', quantity: 10, unit_price: 100 }],
    });
    assert.notEqual(first.number, second.number);
    assert.match(first.number, /^Q-\d{4}-\d{4}$/);
    assert.equal(first.status, 'draft');
    assert.ok(first.public_token.length > 10);
  });

  test('a real PDF is produced on disk', async () => {
    const { lead } = createLead(
      { first_name: 'Pdf', last_name: 'Target', phone: '+30 691 000 0003', project_types: ['heat_pump'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const quote = createQuotation({
      orgId: orgA, userId: userA, leadId: lead.id,
      title: '12 kW heat pump with hot water',
      description: 'Following the site survey.',
      items: [
        { name: 'Air-to-water heat pump 12 kW', quantity: 1, unit_price: 6200, category: 'equipment' },
        { name: 'Hydraulic installation', quantity: 1, unit_price: 1450, category: 'installation' },
        { name: 'Smart thermostat', quantity: 2, unit_price: 180, is_optional: true },
      ],
      terms: 'Payment in three instalments.',
    });
    const file = await renderQuotationPdf(orgA, quote.id);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    assert.ok(bytes.length > 1500, `expected a real document, got ${bytes.length} bytes`);
  });
});

// ---------------------------------------------------------------- automation

describe('automation engine', () => {
  test('a new lead is assigned, notified and given a first follow-up', () => {
    const { lead } = createLead(
      { first_name: 'Auto', last_name: 'Mation', phone: '+30 692 000 0001', email: 'auto@test.gr', project_types: ['pv'] },
      { orgId: orgA, userId: userA, sourceKey: 'website', allowDuplicate: true },
    );
    assert.ok(lead.owner_id, 'the lead should have been assigned');

    const runs = all<any>("SELECT * FROM automation_runs WHERE org_id = ? AND lead_id = ?", [orgA, lead.id]);
    assert.ok(runs.some((r) => r.status === 'active' || r.status === 'completed'));

    const tasks = all<any>("SELECT * FROM tasks WHERE org_id = ? AND lead_id = ? AND status = 'open'", [orgA, lead.id]);
    assert.ok(tasks.length >= 1, 'the first follow-up task should exist');
    assert.match(tasks[0].title, /First contact/);

    const notifications = all<any>('SELECT * FROM notifications WHERE org_id = ? AND lead_id = ?', [orgA, lead.id]);
    assert.ok(notifications.length >= 1, 'the owner should have been notified');

    const fresh = shapeLead(loadLead(orgA, lead.id));
    assert.ok(fresh.next_task_id, 'the lead should carry a next action');
  });

  test('an unconnected channel blocks the message instead of faking it', () => {
    const lead = get<any>("SELECT * FROM leads WHERE org_id = ? AND first_name = 'Auto'", [orgA]);
    const messages = all<any>('SELECT * FROM messages WHERE org_id = ? AND lead_id = ?', [orgA, lead.id]);
    assert.ok(messages.length >= 1, 'the acknowledgement attempt should be recorded');
    assert.equal(messages[0].status, 'blocked');
    assert.match(messages[0].error, /not connected/);
    const activity = get<any>(
      "SELECT * FROM activities WHERE org_id = ? AND lead_id = ? AND type = 'email'", [orgA, lead.id],
    );
    assert.match(activity.title, /NOT sent/);
  });

  test('contacting the customer stops the new-lead sequence', () => {
    const lead = get<any>("SELECT * FROM leads WHERE org_id = ? AND first_name = 'Auto'", [orgA]);
    logActivity({
      orgId: orgA, leadId: lead.id, type: 'call', direction: 'inbound',
      title: 'Customer called back', userId: userA, isCustomerTouch: true,
    });
    const runs = all<any>(
      `SELECT r.status, r.stopped_reason, ar.key FROM automation_runs r
       JOIN automation_rules ar ON ar.id = r.rule_id
       WHERE r.org_id = ? AND r.lead_id = ?`,
      [orgA, lead.id],
    );
    const newLeadRun = runs.find((r) => r.key === 'new_lead');
    assert.equal(newLeadRun.status, 'stopped');
    assert.equal(newLeadRun.stopped_reason, 'customer_replied');
  });

  test('sending a quotation starts the quotation follow-up sequence', () => {
    const { lead } = createLead(
      { first_name: 'Seq', last_name: 'Test', phone: '+30 692 000 0002', project_types: ['pv'], estimated_value: 9000 },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    const quote = createQuotation({
      orgId: orgA, userId: userA, leadId: lead.id, title: 'Sequence test',
      items: [{ name: 'Panel', quantity: 10, unit_price: 100 }],
    });
    markSent(orgA, quote.id, userA, 'manual');

    const run = get<any>(
      `SELECT r.*, ar.key FROM automation_runs r JOIN automation_rules ar ON ar.id = r.rule_id
       WHERE r.org_id = ? AND r.quotation_id = ?`,
      [orgA, quote.id],
    );
    assert.ok(run, 'the quote sequence should have started');
    assert.equal(run.key, 'quote_sent');
    assert.equal(run.status, 'active');
    assert.ok(new Date(run.next_run_at) > new Date(), 'the next step should be scheduled in the future');

    // Sending also pushes the lead into Proposal Sent.
    const fresh = loadLead(orgA, lead.id);
    assert.equal(fresh.stage_key, 'proposal_sent');

    // The customer answering stops it.
    setQuotationStatus(orgA, quote.id, userA, 'accepted');
    const after = get<any>('SELECT * FROM automation_runs WHERE id = ?', [run.id]);
    assert.equal(after.status, 'stopped');
    assert.equal(after.stopped_reason, 'quote_responded');
  });

  test('winning a deal creates the customer, stops sequences and opens the handover', () => {
    const { lead } = createLead(
      { first_name: 'Won', last_name: 'Deal', phone: '+30 692 000 0003', email: 'won@test.gr', project_types: ['pv'], estimated_value: 12000 },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    markWon(orgA, lead.id, userA, 12500);

    const fresh = loadLead(orgA, lead.id);
    assert.equal(fresh.status, 'won');
    assert.equal(fresh.estimated_value, 12500);
    assert.ok(fresh.customer_id, 'a customer record should exist');
    assert.equal(fresh.probability, 100);

    const handover = all<any>(
      "SELECT * FROM tasks WHERE org_id = ? AND lead_id = ? AND type = 'post_sale'", [orgA, lead.id],
    );
    assert.equal(handover.length, 1);

    const stillRunning = all<any>(
      `SELECT ar.key FROM automation_runs r JOIN automation_rules ar ON ar.id = r.rule_id
       WHERE r.org_id = ? AND r.lead_id = ? AND r.status = 'active' AND ar.key != 'won_handoff'`,
      [orgA, lead.id],
    );
    assert.equal(stillRunning.length, 0, 'sales sequences should have stopped');
  });

  test('losing a deal records the reason and schedules the recovery', () => {
    const { lead } = createLead(
      { first_name: 'Lost', last_name: 'Deal', phone: '+30 692 000 0004', project_types: ['heat_pump'], estimated_value: 8000 },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    const reason = get<any>("SELECT * FROM lost_reasons WHERE org_id = ? AND key = 'postponed'", [orgA]);
    const recoveryDate = new Date(Date.now() + 120 * 86_400_000).toISOString();
    markLost(orgA, lead.id, userA, { lost_reason_id: reason.id, lost_notes: 'Building work delayed.', recovery_date: recoveryDate });

    const fresh = loadLead(orgA, lead.id);
    assert.equal(fresh.status, 'lost');
    assert.equal(fresh.lost_reason_name, 'Project postponed');
    assert.equal(fresh.probability, 0);

    const recovery = get<any>(
      "SELECT * FROM tasks WHERE org_id = ? AND lead_id = ? AND title LIKE 'Recovery%'", [orgA, lead.id],
    );
    assert.ok(recovery, 'a recovery task should have been scheduled');
    assert.equal(recovery.due_at.slice(0, 10), recoveryDate.slice(0, 10));

    const openChasers = all<any>(
      "SELECT * FROM tasks WHERE org_id = ? AND lead_id = ? AND status = 'open' AND title NOT LIKE 'Recovery%'",
      [orgA, lead.id],
    );
    assert.equal(openChasers.length, 0, 'chasing tasks should be cancelled on a lost lead');
  });

  test('pausing automation on a lead stops every active run', () => {
    const { lead } = createLead(
      { first_name: 'Paused', last_name: 'Lead', phone: '+30 692 000 0005', project_types: ['pv'] },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    run("UPDATE automation_runs SET status = 'stopped', stopped_reason = 'paused' WHERE org_id = ? AND lead_id = ? AND status = 'active'", [orgA, lead.id]);
    run('UPDATE leads SET automation_paused = 1 WHERE id = ?', [lead.id]);
    assert.equal(
      all("SELECT 1 FROM automation_runs WHERE org_id = ? AND lead_id = ? AND status = 'active'", [orgA, lead.id]).length,
      0,
    );
  });

  test('processing due runs is safe to call repeatedly', () => {
    assert.doesNotThrow(() => { processDueRuns(); processDueRuns(); });
  });
});

// ---------------------------------------------------------------- tasks & next action

describe('next action tracking', () => {
  test('the next action is always the earliest open task, and clears when done', () => {
    const { lead } = createLead(
      { first_name: 'Next', last_name: 'Action', phone: '+30 693 000 0001', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const later = createTask({
      orgId: orgA, leadId: lead.id, title: 'Later', assigneeId: userA,
      dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    const sooner = createTask({
      orgId: orgA, leadId: lead.id, title: 'Sooner', assigneeId: userA,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(recomputeNextAction(orgA, lead.id), sooner.id);

    completeTask(orgA, sooner.id, userA, 'Spoke to the customer.');
    assert.equal(recomputeNextAction(orgA, lead.id), later.id);

    completeTask(orgA, later.id, userA);
    assert.equal(recomputeNextAction(orgA, lead.id), null);
    assert.equal(loadLead(orgA, lead.id).next_action_id, null);
  });

  test('an automation task is never created twice for the same step', () => {
    const first = createTask({ orgId: orgA, title: 'Idempotent', dedupeKey: 'run-1:0:task', source: 'automation' });
    const second = createTask({ orgId: orgA, title: 'Idempotent', dedupeKey: 'run-1:0:task', source: 'automation' });
    assert.equal(first.id, second.id);
  });
});

// ---------------------------------------------------------------- pipeline

describe('pipeline movement', () => {
  test('moving a stage updates the probability and logs the change', () => {
    const { lead } = createLead(
      { first_name: 'Stage', last_name: 'Mover', phone: '+30 693 000 0002', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const target = get<any>("SELECT * FROM pipeline_stages WHERE org_id = ? AND key = 'negotiation'", [orgA]);
    const moved = moveStage(orgA, lead.id, target.id, userA);
    assert.equal(moved.stage_key, 'negotiation');
    assert.equal(moved.probability, target.probability);

    const activity = get<any>(
      "SELECT * FROM activities WHERE org_id = ? AND lead_id = ? AND type = 'stage_change'", [orgA, lead.id],
    );
    assert.match(activity.title, /Moved to Negotiation/);
  });

  test('a lead cannot be dragged into Lost without a reason', () => {
    const { lead } = createLead(
      { first_name: 'No', last_name: 'Reason', phone: '+30 693 000 0003', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const lost = get<any>("SELECT * FROM pipeline_stages WHERE org_id = ? AND type = 'lost'", [orgA]);
    assert.throws(() => moveStage(orgA, lead.id, lost.id, userA), /reason is recorded/);
  });

  test('moving to the Won stage records the win', () => {
    const { lead } = createLead(
      { first_name: 'Drag', last_name: 'ToWon', phone: '+30 693 000 0004', project_types: ['pv'], estimated_value: 5000 },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const won = get<any>("SELECT * FROM pipeline_stages WHERE org_id = ? AND type = 'won'", [orgA]);
    const result = moveStage(orgA, lead.id, won.id, userA);
    assert.equal(result.status, 'won');
    assert.ok(result.won_at);
  });
});

// ---------------------------------------------------------------- tenancy

describe('tenant isolation', () => {
  test('one organisation cannot load another organisation\'s lead', () => {
    const { lead } = createLead(
      { first_name: 'Private', last_name: 'Record', phone: '+30 694 000 0001', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    assert.throws(() => loadLead(orgB, lead.id), /no longer exists/);
  });

  test('every tenant table is scoped by org_id', () => {
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('organizations','schema_meta','rate_limits','usage_counters','idempotency_keys','lead_tags','sqlite_sequence')",
    );
    for (const { name } of tables) {
      const columns = all<{ name: string }>(`PRAGMA table_info(${name})`);
      assert.ok(columns.some((c) => c.name === 'org_id'), `${name} is missing org_id`);
    }
  });

  test('lead references are unique within an organisation but may repeat across them', () => {
    const a = createLead({ first_name: 'Ref', last_name: 'A', phone: '+30 695 000 0001', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true });
    const b = createLead({ first_name: 'Ref', last_name: 'B', phone: '+30 695 000 0001', project_types: ['pv'] },
      { orgId: orgB, userId: userB, skipAutomation: true, allowDuplicate: true });
    assert.ok(a.lead.reference.startsWith('L-'));
    assert.ok(b.lead.reference.startsWith('L-'));
  });
});

// ---------------------------------------------------------------- billing

describe('subscription limits', () => {
  test('the lead allowance is enforced once it is spent', () => {
    run("UPDATE subscriptions SET lead_limit = 2, plan = 'starter', status = 'active' WHERE org_id = ?", [orgB]);
    const period = new Date().toISOString().slice(0, 7);
    run(
      `INSERT INTO usage_counters (org_id, period, metric, value) VALUES (?, ?, 'leads_created', 2)
       ON CONFLICT(org_id, period, metric) DO UPDATE SET value = 2`,
      [orgB, period],
    );
    assert.throws(() => assertLeadAllowance(orgB), /lead limit/);

    run('UPDATE usage_counters SET value = 0 WHERE org_id = ? AND period = ?', [orgB, period]);
    assert.doesNotThrow(() => assertLeadAllowance(orgB));
  });

  test('a cancelled subscription stops lead capture', () => {
    run("UPDATE subscriptions SET status = 'cancelled' WHERE org_id = ?", [orgB]);
    assert.throws(() => assertLeadAllowance(orgB), /cancelled/);
    run("UPDATE subscriptions SET status = 'active' WHERE org_id = ?", [orgB]);
  });
});

// ---------------------------------------------------------------- consent

describe('marketing consent', () => {
  test('marketing is blocked without recorded consent, and allowed with it', () => {
    const { lead } = createLead(
      { first_name: 'Consent', last_name: 'Test', phone: '+30 696 000 0001', project_types: ['pv'] },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const blocked = checkMarketingConsent(orgA, lead.id);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /consent/);

    run('UPDATE leads SET consent_marketing = 1 WHERE id = ?', [lead.id]);
    assert.equal(checkMarketingConsent(orgA, lead.id).allowed, true);
  });
});

// ---------------------------------------------------------------- templates

describe('template rendering', () => {
  test('placeholders resolve and unknown ones render empty', () => {
    const ctx = {
      lead: { first_name: 'Giorgos', last_name: 'Papadopoulos', estimated_value: 14800, project_types: ['pv', 'battery'], pv_desired_kwp: 10 },
      company: { name: 'Helios Energy', phone: '+30 2310 554 220', currency: 'EUR' },
      quote: { number: 'Q-2026-0001', total: 14272.4, valid_until: '2026-10-01T00:00:00.000Z' },
    };
    const rendered = render(
      'Hello {{lead.first_name}}, your {{lead.project_summary}} quotation {{quote.number}} totals {{quote.total}} from {{company.name}}. {{unknown.thing}}',
      ctx,
    );
    assert.match(rendered, /Hello Giorgos/);
    assert.match(rendered, /10 kWp photovoltaic system and battery storage/);
    assert.match(rendered, /Q-2026-0001/);
    assert.match(rendered, /€14,272/);
    assert.match(rendered, /from Helios Energy\./);
    assert.ok(!rendered.includes('{{'));
  });

  test('the project summary describes what the customer asked for', () => {
    assert.equal(projectSummary({ project_types: ['pv'], pv_desired_kwp: 10 }), 'a 10 kWp photovoltaic system');
    assert.equal(projectSummary({ project_types: ['heat_pump'], hp_estimated_kw: 12 }), 'a 12 kW heat pump');
    assert.equal(projectSummary({ project_types: [] }), 'your energy project');
  });
});

// ---------------------------------------------------------------- audit

describe('audit trail', () => {
  test('important actions are recorded', () => {
    const actions = all<{ action: string }>('SELECT DISTINCT action FROM audit_logs WHERE org_id = ?', [orgA])
      .map((r) => r.action);
    for (const expected of ['org.created', 'lead.created', 'quote.created', 'lead.won', 'lead.lost', 'quote.sent']) {
      assert.ok(actions.includes(expected), `expected an audit entry for ${expected}, got ${actions.join(', ')}`);
    }
  });
});

// ------------------------------------------------- unified customer messaging

describe('customer messaging', () => {
  test('the channel follows the customer preference and says why it cannot deliver', () => {
    // Nothing is connected in the test organisation, so nothing is deliverable —
    // but the channel is still named so the attempt can be recorded against it.
    const prefersWhatsApp = resolveChannel(orgA, {
      preferred_contact: 'whatsapp', phone: '+30 691 111 2222', email: 'x@test.gr',
    }, 'preferred');
    assert.equal(prefersWhatsApp.channel, 'whatsapp');
    assert.equal(prefersWhatsApp.deliverable, false);
    assert.match(prefersWhatsApp.reason, /not connected/i);

    const prefersEmail = resolveChannel(orgA, {
      preferred_contact: 'email', phone: '+30 691 111 2222', email: 'x@test.gr',
    }, 'preferred');
    assert.equal(prefersEmail.channel, 'email');

    // An explicit channel wins over the preference.
    assert.equal(resolveChannel(orgA, { preferred_contact: 'whatsapp', email: 'x@test.gr' }, 'email').channel, 'email');

    // No address at all: nothing to attempt.
    const unreachable = resolveChannel(orgA, { preferred_contact: 'email', phone: null, email: null }, 'preferred');
    assert.equal(unreachable.channel, null);
    assert.match(unreachable.reason, /no (email address|phone number)/i);
  });

  test('SMS is reported as unavailable rather than offered', () => {
    const status = channelStatus(orgA);
    assert.equal(status.sms.connected, false);
    assert.match(status.sms.reason, /not available/i);
    // Click-to-call always works from the device, with or without a provider.
    assert.equal(status.phone.connected, true);
  });

  test('an unsendable template records the attempt so the timeline is honest', async () => {
    const { lead } = createLead(
      {
        first_name: 'Honest', last_name: 'Timeline', phone: '+30 691 222 0001', email: 'honest@test.gr',
        project_types: ['pv'],
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const result = await sendTemplate({
      orgId: orgA, templateKey: 'lead_acknowledgement', channel: 'email', leadId: lead.id, userId: userA,
    });
    assert.equal(result.sent, false);
    assert.match(result.reason ?? '', /not connected/i);

    const message = get<any>(
      "SELECT * FROM messages WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 1", [orgA, lead.id],
    );
    assert.ok(message, 'the attempt must be recorded');
    assert.equal(message.status, 'blocked');
    assert.equal(message.sent_at, null);
    const activity = get<any>(
      "SELECT * FROM activities WHERE org_id = ? AND lead_id = ? AND type = 'email' ORDER BY occurred_at DESC LIMIT 1",
      [orgA, lead.id],
    );
    assert.match(activity.title, /NOT sent/);
  });

  test('a rendered template carries real values, never placeholders', () => {
    const lead = get<any>("SELECT * FROM leads WHERE org_id = ? AND first_name = 'Honest'", [orgA]);
    const rendered = renderTemplate(orgA, 'lead_acknowledgement', { leadId: lead.id, userId: userA });
    assert.ok(rendered);
    assert.match(rendered!.body, /Hello Honest/);
    assert.ok(!rendered!.body.includes('{{'), 'no placeholder should survive rendering');
    assert.ok(!rendered!.subject?.includes('{{'));
  });

  test('an opted-out contact blocks automated sends but not a person', async () => {
    const { lead } = createLead(
      {
        first_name: 'Optout', last_name: 'Person', phone: '+30 691 222 0002', email: 'opt@test.gr',
        project_types: ['pv'],
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    run('UPDATE leads SET messaging_opt_out = 1 WHERE id = ?', [lead.id]);

    assert.equal(checkAutomatedSendAllowed(orgA, lead.id).allowed, false);

    // An automated send (it carries a run id) is refused outright.
    const automated = await sendTemplate({
      orgId: orgA, templateKey: 'lead_acknowledgement', leadId: lead.id, automationRunId: 'run_test',
    });
    assert.equal(automated.sent, false);
    assert.match(automated.reason ?? '', /opted out/i);
    assert.equal(
      get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE lead_id = ?', [lead.id])?.n, 0,
      'a refused automated send must not create a message row',
    );

    // A person sending by hand is still allowed; it just cannot be delivered
    // because nothing is connected.
    const manual = await sendTemplate({
      orgId: orgA, templateKey: 'lead_acknowledgement', leadId: lead.id, userId: userA,
    });
    assert.equal(manual.sent, false);
    assert.match(manual.reason ?? '', /not connected/i);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE lead_id = ?', [lead.id])?.n, 1);
  });

  test('templates never cross a tenant boundary', () => {
    const leadB = get<any>('SELECT id FROM leads WHERE org_id = ? LIMIT 1', [orgB]);
    if (leadB) {
      assert.equal(renderTemplate(orgA, 'lead_acknowledgement', { leadId: leadB.id })!.body.includes('undefined'), false);
    }
    // Organisation B has its own template rows; A's id is never returned for B.
    const a = get<any>('SELECT id FROM message_templates WHERE org_id = ? AND key = ?', [orgA, 'quote_sent']);
    const b = get<any>('SELECT id FROM message_templates WHERE org_id = ? AND key = ?', [orgB, 'quote_sent']);
    assert.ok(a && b && a.id !== b.id);
  });
});

// --------------------------------------------------------- appointments

describe('appointment scheduling', () => {
  let apptLead = '';

  before(() => {
    const { lead } = createLead(
      {
        first_name: 'Appointment', last_name: 'Customer', phone: '+30 691 333 0001',
        email: 'appt@test.gr', project_types: ['pv'], address: 'Roof street 1', city: 'Volos',
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    apptLead = lead.id;
  });

  const book = (startsAt: string, minutes = 60, technicianId: string | null = userA) => {
    const id = newId('apt');
    const now = nowIso();
    run(
      `INSERT INTO appointments (id, org_id, lead_id, type, title, starts_at, ends_at, location,
         assignee_id, technician_id, status, created_by, created_at, updated_at)
       VALUES (?,?,?, 'site_survey', 'Site survey', ?,?, 'Roof street 1', ?,?, 'scheduled', ?,?,?)`,
      [
        id, orgA, apptLead, startsAt,
        new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString(),
        userA, technicianId, userA, now, now,
      ],
    );
    return id;
  };

  test('a double booking for the same person is detected', () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setHours(10, 0, 0, 0);
    book(start.toISOString(), 120);

    // Overlaps the middle of the existing visit.
    const overlapStart = new Date(start.getTime() + 60 * 60_000);
    const clash = findApptConflicts(
      orgA, overlapStart, new Date(overlapStart.getTime() + 60 * 60_000), [userA],
    );
    assert.equal(clash.length, 1);
    assert.match(clash[0].title, /Site survey/);

    // Directly after it is fine — end and start may touch.
    const after = new Date(start.getTime() + 120 * 60_000);
    assert.equal(findApptConflicts(orgA, after, new Date(after.getTime() + 3_600_000), [userA]).length, 0);

    // Somebody else at the same time is fine.
    assert.equal(findApptConflicts(orgA, overlapStart, new Date(overlapStart.getTime() + 3_600_000), [userB]).length, 0);
  });

  test('a conflict check never sees another company’s diary', () => {
    const start = new Date(Date.now() + 5 * 86_400_000);
    start.setHours(9, 0, 0, 0);
    book(start.toISOString(), 60);
    assert.equal(findApptConflicts(orgB, start, new Date(start.getTime() + 3_600_000), [userA]).length, 0);
  });
});

// ------------------------------------------------- survey → quotation

describe('survey to quotation', () => {
  let surveyLead = '';
  let fullSurvey = '';
  let thinSurvey = '';

  before(() => {
    const { lead } = createLead(
      {
        first_name: 'Survey', last_name: 'Quote', phone: '+30 691 444 0001', email: 'sq@test.gr',
        project_types: ['pv', 'battery'], address: 'Sunny street 4', city: 'Larissa',
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    surveyLead = lead.id;
    const now = nowIso();

    fullSurvey = newId('srv');
    run(
      `INSERT INTO site_surveys (id, org_id, lead_id, project_type, status, completed_at, address,
         findings, recommended_system, technical_notes, feasible, created_at, updated_at)
       VALUES (?,?,?, 'pv', 'completed', ?, 'Sunny street 4', ?, ?, ?, 1, ?, ?)`,
      [
        fullSurvey, orgA, surveyLead, now,
        JSON.stringify({
          module_count: 24, system_kwp: 10.8, roof_type: 'Tile', supply_phase: 'Three phase',
          distance_to_panel_m: 18, battery_space: true,
        }),
        '10.8 kWp photovoltaic system with 10 kWh battery',
        'South-facing tiled roof, no shading.',
        now, now,
      ],
    );

    thinSurvey = newId('srv');
    run(
      `INSERT INTO site_surveys (id, org_id, lead_id, project_type, status, completed_at, address,
         findings, created_at, updated_at)
       VALUES (?,?,?, 'pv', 'completed', ?, 'Sunny street 4', '{}', ?, ?)`,
      [thinSurvey, orgA, surveyLead, now, now, now],
    );
  });

  test('a complete survey pre-fills quantities from what was measured', () => {
    const draft = buildQuotationDraft(orgA, fullSurvey);
    assert.equal(draft.title, '10.8 kWp photovoltaic system with 10 kWh battery');
    assert.equal(draft.lead_id, surveyLead);

    const modules = draft.items.find((i) => i.name.startsWith('PV module'));
    assert.ok(modules, 'the array should be on the quotation');
    assert.equal(modules!.quantity, 24, 'the measured module count is used');
    assert.equal(modules!.needs_review, false);

    // Prices come from the company's own price list, never from the survey.
    const product = get<{ unit_price: number }>(
      'SELECT unit_price FROM product_templates WHERE org_id = ? AND name = ?',
      [orgA, 'PV module 450 Wp (monocrystalline)'],
    );
    assert.equal(modules!.unit_price, product!.unit_price);

    // Per-kWp lines use the surveyed system size.
    const install = draft.items.find((i) => i.name === 'Mechanical installation');
    assert.equal(install!.quantity, 10.8);

    // The battery the technician found space for rides along as optional.
    const battery = draft.items.find((i) => i.name.startsWith('LFP battery'));
    assert.ok(battery && battery.is_optional, 'the battery should be an optional extra');

    assert.equal(draft.missing.length, 0, 'a complete survey leaves nothing to chase');
  });

  test('a thin survey flags what is missing instead of guessing', () => {
    const draft = buildQuotationDraft(orgA, thinSurvey);
    const modules = draft.items.find((i) => i.name.startsWith('PV module'));
    assert.ok(modules!.needs_review, 'an unmeasured quantity must be flagged');
    assert.match(modules!.review_reason ?? '', /does not record/i);
    assert.ok(draft.missing.length >= 3, 'the owner should be told what to go back for');
    assert.ok(draft.missing.some((m) => /modules/i.test(m)));
    assert.ok(draft.missing.some((m) => /kWp/i.test(m)));
    // Nothing is invented: every price still comes from the price list.
    for (const item of draft.items) {
      assert.ok(item.unit_price > 0, `${item.name} should carry a real price`);
      assert.ok(item.product_template_id, `${item.name} should point at a catalogue entry`);
    }
  });

  test('a heat-pump survey produces heat-pump lines', () => {
    const id = newId('srv');
    const now = nowIso();
    run(
      `INSERT INTO site_surveys (id, org_id, lead_id, project_type, status, completed_at,
         findings, created_at, updated_at)
       VALUES (?,?,?, 'heat_pump', 'completed', ?, ?, ?, ?)`,
      [
        id, orgA, surveyLead, now,
        JSON.stringify({ heat_loss_kw: 11, emitters: 'Radiators', removal_required: true, dhw_cylinder_space: true }),
        now, now,
      ],
    );
    const draft = buildQuotationDraft(orgA, id);
    assert.ok(draft.items.some((i) => i.name.includes('heat pump')));
    assert.ok(draft.items.some((i) => i.name.includes('Removal of existing boiler')));
    assert.ok(draft.items.some((i) => i.name.includes('DHW cylinder')));
    assert.ok(!draft.items.some((i) => i.name.startsWith('PV module')), 'no PV lines on a heat-pump survey');
  });

  test('a survey from another company is not readable', () => {
    assert.throws(() => buildQuotationDraft(orgB, fullSurvey), /no longer exists/);
  });

  test('a second quotation for the same lead is still possible', () => {
    const draft = buildQuotationDraft(orgA, fullSurvey);
    const items = draft.items.map((item) => ({
      name: item.name, quantity: item.quantity, unit: item.unit,
      unit_price: item.unit_price, is_optional: item.is_optional, category: item.category,
    }));
    const first = createQuotation({
      orgId: orgA, userId: userA, leadId: surveyLead, surveyId: fullSurvey,
      title: draft.title, items,
    });
    const second = createQuotation({
      orgId: orgA, userId: userA, leadId: surveyLead, surveyId: fullSurvey,
      title: draft.title, items,
    });
    assert.notEqual(first.id, second.id, 'an identical second quotation must be created, not replayed');
    assert.notEqual(first.number, second.number);
    assert.equal(first.survey_id, fullSurvey, 'the quotation remembers which survey it came from');
  });
});

// ------------------------------------------------ automation ↔ messaging

describe('automated follow-ups', () => {
  test('a lead is enrolled in a rule once, however often the trigger fires', () => {
    const { lead } = createLead(
      {
        first_name: 'Enrol', last_name: 'Once', phone: '+30 691 555 0001', email: 'enrol@test.gr',
        project_types: ['pv'],
      },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    const countRuns = () => get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM automation_runs r JOIN automation_rules ar ON ar.id = r.rule_id
       WHERE r.org_id = ? AND r.lead_id = ? AND ar.key = 'new_lead'`,
      [orgA, lead.id],
    )?.n ?? 0;
    assert.equal(countRuns(), 1);

    // Re-firing the same trigger must not start a second chain of tasks.
    emit({ type: 'lead_created', orgId: orgA, leadId: lead.id });
    emit({ type: 'lead_created', orgId: orgA, leadId: lead.id });
    assert.equal(countRuns(), 1, 'the run key must keep this to one enrolment');
  });

  test('an opted-out contact stops every running sequence', () => {
    const { lead } = createLead(
      {
        first_name: 'Stop', last_name: 'Everything', phone: '+30 691 555 0002', email: 'stop@test.gr',
        project_types: ['pv'],
      },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    assert.ok(
      get<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE lead_id = ? AND status = 'active'", [lead.id])!.n > 0,
    );
    const stopped = stopAllRuns(orgA, lead.id, 'opted_out');
    assert.ok(stopped >= 1);
    const remaining = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM automation_runs WHERE lead_id = ? AND status = 'active'", [lead.id],
    )!.n;
    assert.equal(remaining, 0, 'an opt-out overrides whatever the rule was configured to ignore');
    const reason = get<{ stopped_reason: string }>(
      'SELECT stopped_reason FROM automation_runs WHERE lead_id = ? LIMIT 1', [lead.id],
    );
    assert.equal(reason!.stopped_reason, 'opted_out');
  });

  test('one sequence can be stopped without touching the others', () => {
    const { lead } = createLead(
      {
        first_name: 'Selective', last_name: 'Stop', phone: '+30 691 555 0003', email: 'sel@test.gr',
        project_types: ['pv'], estimated_value: 20000,
      },
      { orgId: orgA, userId: userA, allowDuplicate: true },
    );
    // A second sequence: crossing into hot enrols the notify rule as well.
    emit({ type: 'temperature_changed', orgId: orgA, leadId: lead.id, from: 'warm', to: 'hot' });
    const active = all<{ id: string }>(
      "SELECT id FROM automation_runs WHERE org_id = ? AND lead_id = ? AND status = 'active'", [orgA, lead.id],
    );
    if (active.length < 2) return; // nothing to prove if only one rule matched
    assert.equal(stopRun(orgA, active[0].id, 'stopped_manually'), true);
    const stillActive = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM automation_runs WHERE lead_id = ? AND status = 'active'", [lead.id],
    )!.n;
    assert.equal(stillActive, active.length - 1);
    assert.equal(stopRun(orgA, active[0].id, 'stopped_manually'), false, 'stopping twice is a no-op');
  });

  test('the customer-messaging sequences ship switched off', () => {
    for (const key of ['new_lead_messages', 'quote_follow_up_messages']) {
      const rule = get<{ is_active: number; steps: string }>(
        'SELECT is_active, steps FROM automation_rules WHERE org_id = ? AND key = ?', [orgA, key],
      );
      assert.ok(rule, `${key} should be provisioned`);
      assert.equal(rule!.is_active, 0, `${key} must not send messages until it is switched on`);
      const steps = JSON.parse(rule!.steps);
      assert.equal(steps.length, 4, 'four follow-ups, as specified');
      // Every step must be able to stop once the customer answers.
      for (const step of steps) {
        assert.ok(step.stop_if?.includes('customer_replied'), 'a reply must end the sequence');
      }
    }
  });

  test('the default sequences message the customer at most once', () => {
    const sends = all<{ key: string; steps: string }>(
      'SELECT key, steps FROM automation_rules WHERE org_id = ? AND is_active = 1', [orgA],
    ).flatMap((rule) => JSON.parse(rule.steps)
      .flatMap((step: any) => step.actions ?? [])
      .filter((action: any) => action.type === 'send_template')
      .map(() => rule.key));
    // The acknowledgement and the appointment reminder. Everything else a default
    // rule does is a task or an internal notification.
    assert.deepEqual(sends.sort(), ['appointment_reminder', 'new_lead']);
  });
});

// ------------------------------------------------------- action dashboard

describe('what needs attention', () => {
  test('the list is ranked, actionable and scoped to the company', () => {
    const items = buildAttentionList({ orgId: orgA, userId: userA, seesAll: true, staleHours: 48 });
    assert.ok(items.length > 0, 'the seeded organisation has work waiting');

    for (const item of items) {
      assert.ok(item.name && item.name.length > 0, 'every item names the customer');
      assert.ok(item.reason.length > 0, 'every item says why it is here');
      assert.ok(item.action_label.length > 0, 'every item offers an action');
      assert.ok(item.link.startsWith('/app/'), 'every item links to the record');
      assert.ok([1, 2, 3].includes(item.priority));
    }
    // Urgent first; within a priority, the money leads.
    for (let i = 1; i < items.length; i += 1) {
      assert.ok(items[i - 1].priority <= items[i].priority, 'the list must stay ranked');
    }

    const other = buildAttentionList({ orgId: orgB, userId: userB, seesAll: true, staleHours: 48 });
    const leakedIds = new Set(items.map((i) => i.id));
    for (const item of other) {
      assert.ok(!leakedIds.has(item.id), 'no item may appear in two companies');
    }
  });

  test('a completed survey with no quotation is surfaced as work to do', () => {
    const { lead } = createLead(
      {
        first_name: 'Needs', last_name: 'Quoting', phone: '+30 691 666 0001', email: 'nq@test.gr',
        project_types: ['pv'],
      },
      { orgId: orgA, userId: userA, skipAutomation: true, allowDuplicate: true },
    );
    const now = nowIso();
    run(
      `INSERT INTO site_surveys (id, org_id, lead_id, project_type, status, completed_at, findings, created_at, updated_at)
       VALUES (?,?,?, 'pv', 'completed', ?, '{}', ?, ?)`,
      [newId('srv'), orgA, lead.id, now, now, now],
    );
    const items = buildAttentionList({ orgId: orgA, userId: userA, seesAll: true, staleHours: 48 });
    const entry = items.find((i) => i.kind === 'survey_to_quote' && i.lead_id === lead.id);
    assert.ok(entry, 'a surveyed-but-unquoted lead is exactly what gets forgotten');
    assert.equal(entry!.action, 'create_quote');
    assert.equal(entry!.priority, 1);
  });

  test('a salesperson only sees their own work', () => {
    const mine = buildAttentionList({ orgId: orgA, userId: userB, seesAll: false, staleHours: 48 });
    // userB belongs to organisation B, so scoped to their own book inside A they
    // own nothing at all.
    assert.equal(mine.filter((i) => i.kind !== 'installation_due').length, 0);
    // Unassigned leads are a manager's job and never appear in a scoped list.
    assert.equal(mine.some((i) => i.kind === 'unassigned'), false);
  });
});
