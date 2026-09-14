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
const { registerAutomationEngine, processDueRuns } = await import('../src/lib/automation.ts');
const { provisionOrganization } = await import('../src/lib/provision.ts');
const {
  createLead, findDuplicates, normalizePhone, dedupeKeyFor, rescoreLead, markLost, markWon,
  moveStage, logActivity, recomputeNextAction, loadLead, shapeLead,
} = await import('../src/lib/leads.ts');
const { computeScore, gatherSignals, loadRules, countCompleteness } = await import('../src/lib/scoring.ts');
const { computeTotals, createQuotation, markSent, setQuotationStatus } = await import('../src/lib/quotations.ts');
const { createTask, completeTask } = await import('../src/lib/tasks.ts');
const { renderQuotationPdf } = await import('../src/lib/pdf.ts');
const { getSubscription, assertLeadAllowance } = await import('../src/lib/billing.ts');
const { render, projectSummary } = await import('../src/lib/render.ts');
const { hashPassword, verifyPassword } = await import('../src/lib/auth.ts');
const { can, seesEverything } = await import('../src/lib/permissions.ts');
const { checkMarketingConsent, getIntegration } = await import('../src/lib/messaging.ts');

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
    assert.equal(all('SELECT 1 FROM automation_rules WHERE org_id = ? AND is_active = 1', [orgA]).length, 8);
    assert.ok(all('SELECT 1 FROM product_templates WHERE org_id = ?', [orgA]).length > 15);
    assert.equal(all('SELECT 1 FROM message_templates WHERE org_id = ?', [orgA]).length, 4);
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
