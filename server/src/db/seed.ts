/**
 * Creates a demo organisation with a full team and realistic sample data.
 * Safe to run repeatedly — it skips an organisation that already exists.
 */
import { applySchema, get, insert } from '../lib/db.ts';
import { provisionOrganization, nextAvatarColor } from '../lib/provision.ts';
import { hashPassword } from '../lib/auth.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { seedDemoData } from './demo.ts';
import { registerAutomationEngine } from '../lib/automation.ts';
import { run } from '../lib/db.ts';

applySchema();
registerAutomationEngine();

const DEMO_EMAIL = 'owner@heliosenergy.gr';
const DEMO_PASSWORD = 'VoltaFlow2026!';

const TEAM = [
  { first_name: 'Katerina', last_name: 'Ioannou', email: 'katerina@heliosenergy.gr', role: 'sales_manager' },
  { first_name: 'Alexis', last_name: 'Pappas', email: 'alexis@heliosenergy.gr', role: 'salesperson' },
  { first_name: 'Marina', last_name: 'Chatzi', email: 'marina@heliosenergy.gr', role: 'salesperson' },
  { first_name: 'Stavros', last_name: 'Lambrou', email: 'stavros@heliosenergy.gr', role: 'technician' },
];

function main(): void {
  const existing = get<{ id: string; org_id: string }>('SELECT id, org_id FROM users WHERE email = ?', [DEMO_EMAIL]);
  if (existing) {
    console.log('Demo organisation already exists.');
    printCredentials();
    return;
  }

  const { orgId, userId } = provisionOrganization({
    companyName: 'Helios Energy Solutions',
    firstName: 'Petros',
    lastName: 'Meletiou',
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    phone: '+30 2310 554 220',
    services: ['pv', 'heat_pump', 'battery', 'ev_charger'],
  });

  run(
    `UPDATE organizations SET address = ?, city = ?, postal_code = ?, website = ?, vat_number = ?,
       onboarding_done = 1, onboarding_step = 8, updated_at = ? WHERE id = ?`,
    [
      'Monastiriou 188', 'Thessaloniki', '54628', 'https://heliosenergy.gr', 'EL801234567',
      nowIso(), orgId,
    ],
  );

  for (const member of TEAM) {
    const id = newId('usr');
    const now = nowIso();
    insert('users', {
      id, org_id: orgId, email: member.email,
      password_hash: hashPassword(DEMO_PASSWORD),
      first_name: member.first_name, last_name: member.last_name,
      avatar_color: nextAvatarColor(orgId), role: member.role, status: 'active',
      created_at: now, updated_at: now,
    });
  }

  const result = seedDemoData(orgId, userId);
  console.log(`Created "Helios Energy Solutions" with ${TEAM.length + 1} users.`);
  console.log(`Sample data: ${result.leads} leads, ${result.quotations} quotations, ${result.projects} projects.`);
  printCredentials();
}

function printCredentials(): void {
  console.log('\nSign in with any of these (all use the same password):');
  console.log(`  Owner           ${DEMO_EMAIL}`);
  for (const member of TEAM) console.log(`  ${member.role.padEnd(15)} ${member.email}`);
  console.log(`  Password        ${DEMO_PASSWORD}\n`);
}

main();
