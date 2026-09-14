import { all, get, insert, run } from '../lib/db.ts';
import { newId, randomToken } from '../lib/ids.ts';
import { addDays, nowIso } from '../lib/time.ts';
import { createLead, logActivity, rescoreLead, recomputeNextAction, ensureCustomerForLead } from '../lib/leads.ts';
import { createTask } from '../lib/tasks.ts';
import { createQuotation, markSent, setQuotationStatus } from '../lib/quotations.ts';

/**
 * Realistic sample data for a Greek solar / heat-pump installer, so the
 * dashboard, pipeline, quotations and analytics are alive on first login.
 * Everything created here is tagged so it can be removed again cleanly.
 */

const DEMO_TAG = 'demo-data';

interface DemoLeadSpec {
  first_name: string; last_name: string; company?: string;
  phone: string; email: string; city: string; postal_code: string; address: string;
  source: string; project_types: string[]; estimated_value: number;
  created_days_ago: number; stage: string; notes?: string;
  fields?: Record<string, any>;
  urgency?: string;
  campaign?: string;
  outcome?: 'won' | 'lost' | 'open';
  lost_reason?: string;
  recovery_months?: number;
  quote?: { title: string; items: { name: string; qty: number; unit: string; price: number; category?: string; optional?: boolean }[]; status: string; sent_days_ago?: number };
  activities?: { days_ago: number; type: string; direction: 'inbound' | 'outbound' | 'internal'; title: string; body?: string; outcome?: string }[];
  survey?: { days_ago: number; recommended: string; notes: string; feasible: boolean; cost: number };
}

const LEADS: DemoLeadSpec[] = [
  {
    first_name: 'Giorgos', last_name: 'Papadopoulos',
    phone: '+30 694 512 3388', email: 'g.papadopoulos@example.gr',
    city: 'Thessaloniki', postal_code: '55133', address: 'Ethnikis Antistaseos 42, Kalamaria',
    source: 'referral', project_types: ['pv', 'battery'], estimated_value: 14800,
    created_days_ago: 38, stage: 'won', urgency: 'immediate',
    notes: 'Referred by his brother-in-law, whose 8 kWp system we installed in 2024. Wants to cover the whole household load.',
    fields: {
      pv_desired_kwp: 10, pv_annual_kwh: 12400, pv_monthly_bill: 195, pv_roof_type: 'tile',
      pv_roof_orientation: 'S', pv_roof_area_m2: 78, pv_shading: 'none', pv_property_type: 'detached',
      pv_phase: 'three', pv_grid_connection: 'net_metering', battery_interest: 1, battery_kwh: 10,
      backup_power_interest: 1, budget_known: 1, budget_amount: 16000,
    },
    outcome: 'won',
    quote: {
      title: '10 kWp photovoltaic system with 10 kWh battery storage',
      status: 'accepted', sent_days_ago: 12,
      items: [
        { name: 'PV module 450 Wp (monocrystalline)', qty: 23, unit: 'pcs', price: 95 },
        { name: 'Hybrid inverter 10 kW', qty: 1, unit: 'pcs', price: 1850 },
        { name: 'LFP battery 10 kWh', qty: 1, unit: 'pcs', price: 3400 },
        { name: 'Mounting structure (tiled roof)', qty: 10.35, unit: 'kWp', price: 85 },
        { name: 'Backup / EPS changeover box', qty: 1, unit: 'pcs', price: 620 },
        { name: 'Mechanical installation', qty: 10.35, unit: 'kWp', price: 120, category: 'installation' },
        { name: 'Electrical works and cabling', qty: 10.35, unit: 'kWp', price: 95, category: 'electrical' },
        { name: 'Grid connection paperwork', qty: 1, unit: 'job', price: 350, category: 'service' },
        { name: 'Annual maintenance (year 1)', qty: 1, unit: 'yr', price: 180, category: 'service', optional: true },
      ],
    },
    survey: {
      days_ago: 20, recommended: '10.35 kWp (23 x 450 Wp), 10 kW hybrid inverter, 10 kWh LFP battery',
      notes: 'South-facing tiled roof in good condition. 78 m2 usable, no shading. Three-phase supply, 35 A main breaker, four free ways in the consumer unit. Battery fits in the utility room next to the panel.',
      feasible: true, cost: 14800,
    },
    activities: [
      { days_ago: 38, type: 'call', direction: 'outbound', title: 'First contact call', body: 'Discussed consumption and roof. Very interested, wants a battery for evening load and outage backup.', outcome: 'answered' },
      { days_ago: 34, type: 'email', direction: 'outbound', title: 'Sent technical questionnaire', body: 'Asked for last four electricity bills and a roof photo.' },
      { days_ago: 32, type: 'email', direction: 'inbound', title: 'Customer sent bills and roof photos', body: 'Annual consumption confirmed at 12,400 kWh.' },
      { days_ago: 22, type: 'call', direction: 'outbound', title: 'Booked the site survey', outcome: 'answered' },
      { days_ago: 11, type: 'call', direction: 'outbound', title: 'Walked the customer through the proposal', body: 'Explained the scope line by line. Asked about the maintenance option.', outcome: 'answered' },
      { days_ago: 6, type: 'whatsapp', direction: 'inbound', title: 'Customer accepted the proposal', body: 'Confirmed he wants to proceed and asked when we can start.' },
    ],
  },
  {
    first_name: 'Maria', last_name: 'Nikolaou',
    phone: '+30 697 220 4471', email: 'maria.nikolaou@example.gr',
    city: 'Athens', postal_code: '15232', address: 'Kifisias 118, Chalandri',
    source: 'google_ads', campaign: 'heat-pump-athens-q3',
    project_types: ['heat_pump'], estimated_value: 11200,
    created_days_ago: 14, stage: 'proposal_sent', urgency: 'immediate',
    notes: 'Oil boiler failed last winter. Wants the changeover done before November.',
    fields: {
      hp_existing_system: 'oil_boiler', hp_current_fuel: 'heating oil', hp_annual_heating_cost: 2350,
      hp_property_type: 'detached', hp_property_m2: 185, hp_floors: 2, hp_emitters: 'radiators',
      hp_dhw_required: 1, hp_dhw_litres: 200, hp_cooling_required: 1, hp_insulation: 'average',
      hp_estimated_kw: 12, hp_removal_required: 1, budget_known: 1, budget_amount: 12000,
    },
    quote: {
      title: '12 kW air-to-water heat pump with hot water and boiler removal',
      status: 'sent', sent_days_ago: 5,
      items: [
        { name: 'Air-to-water heat pump 12 kW', qty: 1, unit: 'pcs', price: 6200 },
        { name: 'DHW cylinder 200 L', qty: 1, unit: 'pcs', price: 940 },
        { name: 'Buffer tank 100 L', qty: 1, unit: 'pcs', price: 480 },
        { name: 'Hydraulic installation', qty: 1, unit: 'job', price: 1450, category: 'installation' },
        { name: 'Electrical installation & controls', qty: 1, unit: 'job', price: 620, category: 'electrical' },
        { name: 'Removal of existing boiler', qty: 1, unit: 'job', price: 380, category: 'installation' },
        { name: 'Commissioning & handover', qty: 1, unit: 'job', price: 250, category: 'service' },
        { name: 'Smart thermostat per zone', qty: 2, unit: 'pcs', price: 180, optional: true },
      ],
    },
    survey: {
      days_ago: 8, recommended: '12 kW monobloc air-to-water heat pump, 200 L DHW cylinder, 100 L buffer',
      notes: 'Existing radiators sized for 70 C; two of them need upgrading for a 50 C flow temperature. Outdoor unit goes on the north side of the garden, condensate drain available. Single-phase supply confirmed at 8 kVA.',
      feasible: true, cost: 11200,
    },
    activities: [
      { days_ago: 14, type: 'call', direction: 'outbound', title: 'Qualification call', body: 'Oil boiler broke down. Spends about 2,350 EUR a year on heating oil. Wants cooling in summer too.', outcome: 'answered' },
      { days_ago: 13, type: 'email', direction: 'outbound', title: 'Sent the heat-pump information pack' },
      { days_ago: 9, type: 'call', direction: 'outbound', title: 'Confirmed the survey appointment', outcome: 'answered' },
      { days_ago: 5, type: 'email', direction: 'outbound', title: 'Proposal sent', body: 'Quotation Q-2026-0002 emailed with the survey summary attached.' },
    ],
  },
  {
    first_name: 'Dimitris', last_name: 'Georgiou', company: 'Georgiou Logistics',
    phone: '+30 693 884 1120', email: 'd.georgiou@georgioulogistics.gr',
    city: 'Larissa', postal_code: '41222', address: 'Industrial Park, Block 7',
    source: 'website', project_types: ['pv', 'ev_charger'], estimated_value: 46500,
    created_days_ago: 21, stage: 'negotiation', urgency: '1_3_months',
    notes: 'Warehouse roof, wants to cut daytime consumption and add two chargers for the delivery vans.',
    fields: {
      pv_desired_kwp: 40, pv_annual_kwh: 68000, pv_monthly_bill: 1180, pv_roof_type: 'metal',
      pv_roof_orientation: 'S', pv_roof_area_m2: 420, pv_shading: 'none', pv_property_type: 'industrial',
      pv_phase: 'three', pv_grid_connection: 'net_billing', ev_charger_interest: 1, ev_charger_kw: 22,
      budget_known: 1, budget_amount: 50000,
    },
    quote: {
      title: '40 kWp rooftop PV with two 22 kW EV chargers',
      status: 'viewed', sent_days_ago: 9,
      items: [
        { name: 'PV module 450 Wp (monocrystalline)', qty: 90, unit: 'pcs', price: 92 },
        { name: 'Three-phase inverter 40 kW', qty: 1, unit: 'pcs', price: 4800 },
        { name: 'Mounting structure (trapezoidal metal roof)', qty: 40.5, unit: 'kWp', price: 68 },
        { name: 'DC/AC protection and monitoring', qty: 1, unit: 'set', price: 1750 },
        { name: 'EV charger 22 kW (3-phase)', qty: 2, unit: 'pcs', price: 780 },
        { name: 'Mechanical installation', qty: 40.5, unit: 'kWp', price: 105, category: 'installation' },
        { name: 'Electrical works, cabling and LV panel', qty: 1, unit: 'job', price: 6400, category: 'electrical' },
        { name: 'Grid connection study and paperwork', qty: 1, unit: 'job', price: 1200, category: 'service' },
        { name: 'Load-management controller for the chargers', qty: 1, unit: 'pcs', price: 1250, optional: true },
      ],
    },
    activities: [
      { days_ago: 21, type: 'note', direction: 'internal', title: 'Enquiry received through the website form', body: 'Asked specifically about net billing for a commercial connection.' },
      { days_ago: 20, type: 'call', direction: 'outbound', title: 'Discovery call with the operations manager', outcome: 'answered' },
      { days_ago: 16, type: 'meeting', direction: 'outbound', title: 'Site visit and roof measurement', body: 'Roof is a trapezoidal metal deck in good condition. 420 m2 usable.' },
      { days_ago: 9, type: 'email', direction: 'outbound', title: 'Proposal sent' },
      { days_ago: 4, type: 'call', direction: 'inbound', title: 'Customer called about payment terms', body: 'Asked whether the deposit can be split across two invoices. Finance director wants to compare one more offer.', outcome: 'answered' },
    ],
  },
  {
    first_name: 'Eleni', last_name: 'Vasileiou',
    phone: '+30 698 771 2043', email: 'eleni.vasileiou@example.gr',
    city: 'Patras', postal_code: '26222', address: 'Korinthou 210',
    source: 'instagram', campaign: 'summer-pv-reels',
    project_types: ['pv'], estimated_value: 6400,
    created_days_ago: 3, stage: 'contacted', urgency: '3_6_months',
    notes: 'Apartment building roof, needs agreement from the other owners first.',
    fields: {
      pv_desired_kwp: 5, pv_monthly_bill: 85, pv_roof_type: 'flat_concrete',
      pv_property_type: 'apartment', pv_phase: 'single',
    },
    activities: [
      { days_ago: 3, type: 'call', direction: 'outbound', title: 'First contact attempt', outcome: 'no_answer' },
      { days_ago: 2, type: 'whatsapp', direction: 'outbound', title: 'WhatsApp message sent', body: 'Introduced ourselves and asked for a good time to call.' },
      { days_ago: 2, type: 'whatsapp', direction: 'inbound', title: 'Customer replied', body: 'Interested, but needs the building assembly to approve the roof use. Asked us to call back in two weeks.' },
    ],
  },
  {
    first_name: 'Nikos', last_name: 'Antoniou',
    phone: '+30 694 330 9915', email: 'n.antoniou@example.gr',
    city: 'Heraklion', postal_code: '71303', address: 'Knossou 88',
    source: 'facebook', project_types: ['heat_pump', 'pv'], estimated_value: 19500,
    created_days_ago: 9, stage: 'site_survey', urgency: '1_3_months',
    notes: 'Renovating the whole house. Wants PV and a heat pump commissioned together.',
    fields: {
      hp_existing_system: 'ac_units', hp_property_type: 'detached', hp_property_m2: 145, hp_floors: 1,
      hp_emitters: 'underfloor', hp_dhw_required: 1, hp_insulation: 'good', hp_estimated_kw: 10,
      hp_cooling_required: 1, pv_desired_kwp: 6, pv_annual_kwh: 9100, pv_monthly_bill: 140,
      pv_roof_type: 'tile', pv_roof_orientation: 'SW', pv_roof_area_m2: 55, pv_phase: 'single',
    },
    activities: [
      { days_ago: 9, type: 'call', direction: 'outbound', title: 'Qualification call', body: 'Full renovation, underfloor heating already being installed. Good fit for a low flow temperature heat pump.', outcome: 'answered' },
      { days_ago: 7, type: 'email', direction: 'outbound', title: 'Sent combined PV + heat pump information' },
      { days_ago: 5, type: 'email', direction: 'inbound', title: 'Customer sent the architect drawings' },
      { days_ago: 2, type: 'call', direction: 'outbound', title: 'Survey booked with the technician', outcome: 'answered' },
    ],
  },
  {
    first_name: 'Sofia', last_name: 'Karagianni',
    phone: '+30 695 118 7734', email: 'sofia.karagianni@example.gr',
    city: 'Volos', postal_code: '38221', address: 'Iasonos 45',
    source: 'google_ads', campaign: 'pv-battery-generic',
    project_types: ['pv', 'battery'], estimated_value: 11900,
    created_days_ago: 27, stage: 'proposal_sent',
    notes: 'Compared three installers. Price-sensitive but engaged.',
    fields: {
      pv_desired_kwp: 8, pv_annual_kwh: 9800, pv_monthly_bill: 155, pv_roof_type: 'tile',
      pv_roof_orientation: 'SE', pv_roof_area_m2: 62, pv_property_type: 'detached', pv_phase: 'single',
      battery_interest: 1, battery_kwh: 5,
    },
    quote: {
      title: '8 kWp photovoltaic system with 5 kWh storage',
      status: 'awaiting_response', sent_days_ago: 16,
      items: [
        { name: 'PV module 450 Wp (monocrystalline)', qty: 18, unit: 'pcs', price: 95 },
        { name: 'Hybrid inverter 8 kW', qty: 1, unit: 'pcs', price: 1650 },
        { name: 'LFP battery 5 kWh', qty: 1, unit: 'pcs', price: 2100 },
        { name: 'Mounting structure (tiled roof)', qty: 8.1, unit: 'kWp', price: 85 },
        { name: 'Mechanical installation', qty: 8.1, unit: 'kWp', price: 120, category: 'installation' },
        { name: 'Electrical works and cabling', qty: 8.1, unit: 'kWp', price: 95, category: 'electrical' },
        { name: 'Grid connection paperwork', qty: 1, unit: 'job', price: 350, category: 'service' },
      ],
    },
    activities: [
      { days_ago: 27, type: 'call', direction: 'outbound', title: 'First contact call', outcome: 'answered' },
      { days_ago: 24, type: 'meeting', direction: 'outbound', title: 'Home visit and roof assessment' },
      { days_ago: 16, type: 'email', direction: 'outbound', title: 'Proposal sent' },
      { days_ago: 10, type: 'call', direction: 'outbound', title: 'Follow-up call', body: 'Still comparing offers. Asked about the battery warranty.', outcome: 'answered' },
    ],
  },
  {
    first_name: 'Kostas', last_name: 'Dimitriou',
    phone: '+30 690 442 8817', email: 'k.dimitriou@example.gr',
    city: 'Ioannina', postal_code: '45333', address: 'Dodonis 155',
    source: 'phone', project_types: ['heat_pump'], estimated_value: 9400,
    created_days_ago: 64, stage: 'lost', outcome: 'lost', lost_reason: 'postponed', recovery_months: 5,
    notes: 'Wanted the work done but is waiting for the building renovation to finish.',
    fields: {
      hp_existing_system: 'pellet', hp_property_type: 'detached', hp_property_m2: 120, hp_floors: 2,
      hp_emitters: 'radiators', hp_annual_heating_cost: 1450, hp_insulation: 'poor', hp_estimated_kw: 10,
    },
    activities: [
      { days_ago: 64, type: 'call', direction: 'inbound', title: 'Customer called us', body: 'Found us through a neighbour.', outcome: 'answered' },
      { days_ago: 60, type: 'meeting', direction: 'outbound', title: 'Home visit' },
      { days_ago: 52, type: 'email', direction: 'outbound', title: 'Proposal sent' },
      { days_ago: 40, type: 'call', direction: 'outbound', title: 'Customer postponed the project', body: 'Renovation delayed; asked us to come back in spring.', outcome: 'callback' },
    ],
  },
  {
    first_name: 'Anna', last_name: 'Stefanidou',
    phone: '+30 699 550 1177', email: 'anna.stefanidou@example.gr',
    city: 'Thessaloniki', postal_code: '54646', address: 'Delfon 74',
    source: 'existing_customer', project_types: ['ev_charger'], estimated_value: 1350,
    created_days_ago: 6, stage: 'qualified',
    notes: 'We installed her 6 kWp system in 2024. Just bought an electric car.',
    fields: { ev_charger_interest: 1, ev_charger_kw: 11, pv_existing_system: 1, pv_phase: 'single', pv_install_location: 'garage' },
    activities: [
      { days_ago: 6, type: 'whatsapp', direction: 'inbound', title: 'Existing customer asked about a charger', body: 'Bought an EV, wants to charge from the PV surplus.' },
      { days_ago: 5, type: 'call', direction: 'outbound', title: 'Discussed options', body: 'Single-phase 11 kW is not possible; recommended 7.4 kW with solar-surplus charging.', outcome: 'answered' },
    ],
  },
  {
    first_name: 'Petros', last_name: 'Manolis',
    phone: '+30 697 909 3355', email: 'p.manolis@example.gr',
    city: 'Chania', postal_code: '73100', address: 'Kydonias 30',
    source: 'whatsapp', project_types: ['pv'], estimated_value: 7800,
    created_days_ago: 1, stage: 'new', urgency: 'immediate',
    notes: 'Asked for a quotation straight away. Has the bills ready.',
    fields: {
      pv_desired_kwp: 6, pv_annual_kwh: 8200, pv_monthly_bill: 132, pv_roof_type: 'flat_concrete',
      pv_roof_orientation: 'S', pv_roof_area_m2: 45, pv_property_type: 'detached', pv_phase: 'single',
    },
    activities: [
      { days_ago: 1, type: 'whatsapp', direction: 'inbound', title: 'Enquiry received over WhatsApp', body: 'Wants a 6 kWp system quoted this week.' },
    ],
  },
  {
    first_name: 'Christina', last_name: 'Alexiou',
    phone: '+30 694 007 6621', email: 'c.alexiou@example.gr',
    city: 'Athens', postal_code: '11525', address: 'Mesogeion 302',
    source: 'partner', project_types: ['pv', 'heat_pump', 'battery'], estimated_value: 28400,
    created_days_ago: 45, stage: 'technical',
    notes: 'Introduced by an architect partner. New build, everything electric.',
    fields: {
      pv_desired_kwp: 12, pv_annual_kwh: 15600, pv_roof_type: 'flat_concrete', pv_roof_orientation: 'S',
      pv_roof_area_m2: 110, pv_property_type: 'detached', pv_phase: 'three', battery_interest: 1,
      battery_kwh: 15, hp_property_m2: 240, hp_floors: 2, hp_emitters: 'underfloor',
      hp_insulation: 'excellent', hp_estimated_kw: 14, hp_dhw_required: 1, hp_cooling_required: 1,
    },
    activities: [
      { days_ago: 45, type: 'email', direction: 'inbound', title: 'Architect introduction', body: 'Partner forwarded the project brief and drawings.' },
      { days_ago: 43, type: 'call', direction: 'outbound', title: 'Introductory call with the owner', outcome: 'answered' },
      { days_ago: 30, type: 'meeting', direction: 'outbound', title: 'Design meeting with the architect' },
      { days_ago: 12, type: 'email', direction: 'outbound', title: 'Sent the preliminary system layout' },
    ],
  },
  {
    first_name: 'Thanasis', last_name: 'Roussos',
    phone: '+30 693 221 4408', email: 't.roussos@example.gr',
    city: 'Kavala', postal_code: '65302', address: 'Erythrou Stavrou 12',
    source: 'google_ads', campaign: 'pv-north-greece',
    project_types: ['pv'], estimated_value: 8900,
    created_days_ago: 52, stage: 'lost', outcome: 'lost', lost_reason: 'competitor',
    notes: 'Went with a cheaper offer that used a different inverter brand.',
    fields: { pv_desired_kwp: 7, pv_annual_kwh: 8800, pv_roof_type: 'tile', pv_phase: 'single' },
    activities: [
      { days_ago: 52, type: 'call', direction: 'outbound', title: 'First contact call', outcome: 'answered' },
      { days_ago: 46, type: 'email', direction: 'outbound', title: 'Proposal sent' },
      { days_ago: 33, type: 'call', direction: 'outbound', title: 'Customer chose another installer', body: 'Competitor was about 900 EUR cheaper with a different inverter.', outcome: 'not_interested' },
    ],
  },
  {
    first_name: 'Vasiliki', last_name: 'Moraiti',
    phone: '+30 698 664 2290', email: 'v.moraiti@example.gr',
    city: 'Rhodes', postal_code: '85100', address: 'Ialysou 61',
    source: 'website', project_types: ['pv', 'battery'], estimated_value: 16700,
    created_days_ago: 70, stage: 'won', outcome: 'won',
    notes: 'Holiday rental. Wanted resilience during summer outages.',
    fields: {
      pv_desired_kwp: 10, pv_annual_kwh: 13500, pv_roof_type: 'flat_concrete', pv_roof_orientation: 'S',
      pv_property_type: 'commercial', pv_phase: 'three', battery_interest: 1, battery_kwh: 15,
      backup_power_interest: 1,
    },
    quote: {
      title: '10 kWp PV with 15 kWh storage and backup supply',
      status: 'accepted', sent_days_ago: 48,
      items: [
        { name: 'PV module 450 Wp (monocrystalline)', qty: 23, unit: 'pcs', price: 95 },
        { name: 'Hybrid inverter 10 kW', qty: 1, unit: 'pcs', price: 1850 },
        { name: 'LFP battery 10 kWh', qty: 1.5, unit: 'pcs', price: 3400 },
        { name: 'Backup / EPS changeover box', qty: 1, unit: 'pcs', price: 620 },
        { name: 'Mounting structure (flat roof ballast)', qty: 10.35, unit: 'kWp', price: 95 },
        { name: 'Mechanical installation', qty: 10.35, unit: 'kWp', price: 120, category: 'installation' },
        { name: 'Electrical works and cabling', qty: 10.35, unit: 'kWp', price: 95, category: 'electrical' },
        { name: 'Grid connection paperwork', qty: 1, unit: 'job', price: 350, category: 'service' },
      ],
    },
    activities: [
      { days_ago: 70, type: 'note', direction: 'internal', title: 'Website enquiry received' },
      { days_ago: 68, type: 'call', direction: 'outbound', title: 'Qualification call', outcome: 'answered' },
      { days_ago: 58, type: 'meeting', direction: 'outbound', title: 'Site survey on the island' },
      { days_ago: 48, type: 'email', direction: 'outbound', title: 'Proposal sent' },
      { days_ago: 41, type: 'call', direction: 'inbound', title: 'Customer accepted', outcome: 'interested' },
    ],
  },
];

export function seedDemoData(orgId: string, userId: string): { leads: number; quotations: number; projects: number } {
  const existing = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM leads l JOIN lead_tags lt ON lt.lead_id = l.id JOIN tags t ON t.id = lt.tag_id WHERE l.org_id = ? AND t.name = ?",
    [orgId, DEMO_TAG],
  )?.n ?? 0;
  if (existing > 0) return { leads: 0, quotations: 0, projects: 0 };

  const tagId = ensureDemoTag(orgId);
  const salesUsers = all<{ id: string }>(
    "SELECT id FROM users WHERE org_id = ? AND status = 'active' AND role IN ('owner','admin','sales_manager','salesperson') ORDER BY created_at",
    [orgId],
  );
  const technician = get<{ id: string }>(
    "SELECT id FROM users WHERE org_id = ? AND role = 'technician' AND status = 'active' LIMIT 1", [orgId],
  );
  const stages = new Map(
    all<{ id: string; key: string; probability: number }>(
      'SELECT id, key, probability FROM pipeline_stages WHERE org_id = ?', [orgId],
    ).map((s) => [s.key, s]),
  );

  let quotationCount = 0;
  let projectCount = 0;

  LEADS.forEach((spec, index) => {
    const createdAt = addDays(new Date(), -spec.created_days_ago);
    const owner = salesUsers[index % Math.max(salesUsers.length, 1)]?.id ?? userId;

    const { lead } = createLead(
      {
        first_name: spec.first_name,
        last_name: spec.last_name,
        company: spec.company,
        phone: spec.phone,
        email: spec.email,
        address: spec.address,
        city: spec.city,
        postal_code: spec.postal_code,
        notes: spec.notes,
        project_types: spec.project_types,
        estimated_value: spec.estimated_value,
        campaign: spec.campaign,
        urgency: spec.urgency ?? 'unknown',
        // Everyone past the first conversation has asked us for a price.
        requested_quote: spec.stage === 'new' ? 0 : 1,
        expected_close_date: addDays(new Date(), 14 + index * 3),
        ...(spec.fields ?? {}),
      },
      {
        orgId, userId, channel: 'manual', sourceKey: spec.source,
        allowDuplicate: true, skipAutomation: true, assignTo: owner,
      },
    );

    // Backdate the record so the analytics and dashboard look real.
    run('UPDATE leads SET created_at = ?, updated_at = ? WHERE id = ?', [createdAt, createdAt, lead.id]);
    run('UPDATE activities SET occurred_at = ?, created_at = ? WHERE lead_id = ?', [createdAt, createdAt, lead.id]);
    run('INSERT OR IGNORE INTO lead_tags (org_id, lead_id, tag_id) VALUES (?, ?, ?)', [orgId, lead.id, tagId]);

    const stage = stages.get(spec.stage);
    if (stage) {
      run('UPDATE leads SET stage_id = ?, probability = ?, stage_entered_at = ? WHERE id = ?', [
        stage.id, stage.probability, addDays(new Date(), -Math.max(1, Math.floor(spec.created_days_ago / 3))), lead.id,
      ]);
    }

    let lastTouch = createdAt;
    let firstOutbound: string | null = null;
    for (const activity of spec.activities ?? []) {
      const occurredAt = addDays(new Date(), -activity.days_ago);
      logActivity({
        orgId, leadId: lead.id, type: activity.type, direction: activity.direction,
        title: activity.title, body: activity.body ?? null, outcome: activity.outcome ?? null,
        occurredAt, userId: owner, isCustomerTouch: activity.type !== 'note',
      });
      if (occurredAt > lastTouch) lastTouch = occurredAt;
      if (activity.direction === 'outbound' && !firstOutbound) firstOutbound = occurredAt;
    }
    if (firstOutbound) run('UPDATE leads SET first_contacted_at = ? WHERE id = ?', [firstOutbound, lead.id]);
    run('UPDATE leads SET last_activity_at = ? WHERE id = ?', [lastTouch, lead.id]);

    // Site survey and its appointment.
    if (spec.survey) {
      const surveyAt = addDays(new Date(), -spec.survey.days_ago);
      const apptId = newId('apt');
      insert('appointments', {
        id: apptId, org_id: orgId, lead_id: lead.id, type: 'site_survey',
        title: `Site survey — ${spec.first_name} ${spec.last_name}`,
        starts_at: surveyAt, ends_at: addDays(new Date(), -spec.survey.days_ago + 0.04),
        location: `${spec.address}, ${spec.city}`,
        assignee_id: owner, technician_id: technician?.id ?? null,
        status: 'completed', created_by: userId, created_at: surveyAt, updated_at: surveyAt,
      });
      insert('site_surveys', {
        id: newId('srv'), org_id: orgId, lead_id: lead.id, appointment_id: apptId,
        technician_id: technician?.id ?? null,
        project_type: spec.project_types[0], status: 'completed',
        scheduled_at: surveyAt, completed_at: surveyAt,
        address: `${spec.address}, ${spec.city}`,
        findings: JSON.stringify({ roof_condition: 'Good', access_notes: 'Van access to the property, no scaffolding required.' }),
        technical_notes: spec.survey.notes,
        feasible: spec.survey.feasible ? 1 : 0,
        recommended_system: spec.survey.recommended,
        estimated_cost: spec.survey.cost,
        created_at: surveyAt, updated_at: surveyAt,
      });
    }

    // Quotation.
    if (spec.quote) {
      const quote = createQuotation({
        orgId, userId: owner, leadId: lead.id,
        title: spec.quote.title,
        description: `Prepared following the technical assessment for ${spec.address}, ${spec.city}.`,
        items: spec.quote.items.map((item, position) => ({
          category: item.category ?? 'equipment',
          name: item.name, quantity: item.qty, unit: item.unit, unit_price: item.price,
          is_optional: item.optional ?? false, position,
        })),
      });
      quotationCount += 1;
      const sentAt = addDays(new Date(), -(spec.quote.sent_days_ago ?? 5));
      run('UPDATE quotations SET created_at = ?, updated_at = ? WHERE id = ?', [sentAt, sentAt, quote.id]);
      if (spec.quote.status !== 'draft') {
        markSent(orgId, quote.id, owner, 'email');
        run('UPDATE quotations SET sent_at = ? WHERE id = ?', [sentAt, quote.id]);
        if (spec.quote.status !== 'sent') {
          setQuotationStatus(orgId, quote.id, owner, spec.quote.status);
        }
      }
      // Stop the follow-up sequences the demo quotations would otherwise start.
      run("UPDATE automation_runs SET status = 'completed', next_run_at = NULL WHERE org_id = ? AND lead_id = ?", [orgId, lead.id]);
    }

    // Outcome.
    if (spec.outcome === 'won') {
      const wonAt = addDays(new Date(), -Math.max(1, Math.floor(spec.created_days_ago / 6)));
      run(
        `UPDATE leads SET status = 'won', won_at = ?, probability = 100, stage_id = ? WHERE id = ?`,
        [wonAt, stages.get('won')?.id ?? null, lead.id],
      );
      const customerId = ensureCustomerForLead(orgId, lead.id, userId);
      const projectId = newId('prj');
      insert('projects', {
        id: projectId, org_id: orgId, customer_id: customerId, lead_id: lead.id,
        name: spec.quote?.title ?? `${spec.project_types[0]} installation`,
        project_type: spec.project_types[0],
        status: spec.created_days_ago > 60 ? 'completed' : 'scheduled',
        system_size: spec.fields?.pv_desired_kwp ? `${spec.fields.pv_desired_kwp} kWp` : spec.fields?.hp_estimated_kw ? `${spec.fields.hp_estimated_kw} kW` : null,
        contract_value: spec.estimated_value,
        installation_status: spec.created_days_ago > 60 ? 'handed_over' : 'scheduled',
        planned_install_date: addDays(new Date(), spec.created_days_ago > 60 ? -25 : 12),
        actual_install_date: spec.created_days_ago > 60 ? addDays(new Date(), -25) : null,
        technician_id: technician?.id ?? null,
        payment_status: spec.created_days_ago > 60 ? 'paid' : 'deposit_paid',
        amount_paid: spec.created_days_ago > 60 ? spec.estimated_value : Math.round(spec.estimated_value * 0.4),
        warranty_years: 2,
        warranty_expires_at: addDays(new Date(), 730),
        maintenance_due_at: addDays(new Date(), 365),
        created_at: wonAt, updated_at: wonAt,
      });
      projectCount += 1;
      run('UPDATE customers SET lifetime_value = ? WHERE id = ?', [spec.estimated_value, customerId]);
      if (spec.created_days_ago <= 60) {
        createTask({
          orgId, title: `Installation handover: ${spec.first_name} ${spec.last_name}`,
          description: 'Confirm the installation date with the customer and send the pre-installation checklist.',
          type: 'post_sale', leadId: lead.id, projectId, assigneeId: owner,
          dueAt: addDays(new Date(), 2), priority: 'high', source: 'system', createdBy: userId,
        });
      }
    } else if (spec.outcome === 'lost') {
      const reason = get<{ id: string }>('SELECT id FROM lost_reasons WHERE org_id = ? AND key = ?', [
        orgId, spec.lost_reason ?? 'other',
      ]);
      const lostAt = addDays(new Date(), -Math.max(1, Math.floor(spec.created_days_ago / 3)));
      run(
        `UPDATE leads SET status = 'lost', lost_at = ?, lost_reason_id = ?, lost_notes = ?, recovery_date = ?,
           probability = 0, stage_id = ? WHERE id = ?`,
        [
          lostAt, reason?.id ?? null, spec.notes ?? null,
          spec.recovery_months ? addDays(new Date(), spec.recovery_months * 30) : null,
          stages.get('lost')?.id ?? null, lead.id,
        ],
      );
      run("UPDATE tasks SET status = 'cancelled' WHERE org_id = ? AND lead_id = ? AND status = 'open'", [orgId, lead.id]);
    } else {
      // Open leads get a realistic next action — except two, deliberately left
      // without one so the "needs attention" panel has something to show.
      if (index % 5 !== 3) {
        createTask({
          orgId,
          title: nextActionFor(spec),
          type: spec.stage === 'proposal_sent' ? 'follow_up' : 'call',
          leadId: lead.id, assigneeId: owner,
          dueAt: addDays(new Date(), index % 4 === 0 ? -1 : index % 3),
          priority: spec.estimated_value > 15000 ? 'high' : 'normal',
          source: 'manual', createdBy: userId,
        });
      }
    }

    recomputeNextAction(orgId, lead.id);
    rescoreLead(orgId, lead.id, { silent: true });
  });

  // An upcoming survey so the calendar and the technician's queue are populated.
  const upcomingLead = get<{ id: string; first_name: string; last_name: string; address: string; city: string; owner_id: string }>(
    `SELECT l.id, l.first_name, l.last_name, l.address, l.city, l.owner_id FROM leads l
     JOIN pipeline_stages st ON st.id = l.stage_id
     WHERE l.org_id = ? AND st.key = 'site_survey' LIMIT 1`,
    [orgId],
  );
  if (upcomingLead) {
    const startsAt = addDays(new Date(), 1);
    const apptId = newId('apt');
    const now = nowIso();
    insert('appointments', {
      id: apptId, org_id: orgId, lead_id: upcomingLead.id, type: 'site_survey',
      title: `Site survey — ${upcomingLead.first_name} ${upcomingLead.last_name}`,
      starts_at: startsAt, ends_at: addDays(new Date(), 1.04),
      location: `${upcomingLead.address}, ${upcomingLead.city}`,
      assignee_id: upcomingLead.owner_id, technician_id: technician?.id ?? null,
      status: 'scheduled', created_by: userId, created_at: now, updated_at: now,
    });
    insert('site_surveys', {
      id: newId('srv'), org_id: orgId, lead_id: upcomingLead.id, appointment_id: apptId,
      technician_id: technician?.id ?? null, project_type: 'heat_pump', status: 'scheduled',
      scheduled_at: startsAt, address: `${upcomingLead.address}, ${upcomingLead.city}`,
      findings: '{}', created_at: now, updated_at: now,
    });
  }

  run('UPDATE organizations SET demo_data_loaded = 1, updated_at = ? WHERE id = ?', [nowIso(), orgId]);
  return { leads: LEADS.length, quotations: quotationCount, projects: projectCount };
}

function nextActionFor(spec: DemoLeadSpec): string {
  const name = `${spec.first_name} ${spec.last_name}`;
  switch (spec.stage) {
    case 'new': return `First contact: call ${name}`;
    case 'contacted': return `Qualify ${name} — confirm consumption and roof details`;
    case 'qualified': return `Book the technical assessment with ${name}`;
    case 'technical': return `Complete the system design for ${name}`;
    case 'site_survey': return `Confirm the survey appointment with ${name}`;
    case 'proposal_prep': return `Finish the proposal for ${name}`;
    case 'proposal_sent': return `Follow up on the proposal sent to ${name}`;
    case 'negotiation': return `Agree final terms with ${name}`;
    default: return `Follow up with ${name}`;
  }
}

function ensureDemoTag(orgId: string): string {
  const existing = get<{ id: string }>('SELECT id FROM tags WHERE org_id = ? AND name = ?', [orgId, DEMO_TAG]);
  if (existing) return existing.id;
  const id = newId('tag');
  insert('tags', { id, org_id: orgId, name: DEMO_TAG, color: '#94a3b8', created_at: nowIso() });
  return id;
}

/** Removes every record created by the demo seeder, leaving real data untouched. */
export function removeDemoData(orgId: string): { leads: number } {
  const tag = get<{ id: string }>('SELECT id FROM tags WHERE org_id = ? AND name = ?', [orgId, DEMO_TAG]);
  if (!tag) return { leads: 0 };
  const leadIds = all<{ lead_id: string }>('SELECT lead_id FROM lead_tags WHERE org_id = ? AND tag_id = ?', [
    orgId, tag.id,
  ]).map((r) => r.lead_id);
  if (leadIds.length === 0) return { leads: 0 };
  const placeholders = leadIds.map(() => '?').join(',');

  const customerIds = all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM leads WHERE org_id = ? AND id IN (${placeholders}) AND customer_id IS NOT NULL`,
    [orgId, ...leadIds],
  ).map((r) => r.customer_id);

  for (const table of ['automation_runs', 'quotations', 'tasks', 'appointments', 'site_surveys', 'documents', 'messages', 'activities', 'notifications']) {
    run(`DELETE FROM ${table} WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]);
  }
  run(`DELETE FROM projects WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]);
  run(`DELETE FROM leads WHERE org_id = ? AND id IN (${placeholders})`, [orgId, ...leadIds]);
  for (const customerId of customerIds) {
    const remaining = get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE customer_id = ?', [customerId])?.n ?? 0;
    if (remaining === 0) run('DELETE FROM customers WHERE id = ? AND org_id = ?', [customerId, orgId]);
  }
  run('DELETE FROM tags WHERE id = ?', [tag.id]);
  run('UPDATE organizations SET demo_data_loaded = 0, updated_at = ? WHERE id = ?', [nowIso(), orgId]);
  return { leads: leadIds.length };
}

export { DEMO_TAG, randomToken };
