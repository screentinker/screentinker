'use strict';

const t = require('./thermo');

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

// money formatting
eq('formatMoney USD', t.formatMoney(12450, 'USD'), '$12,450');
eq('formatMoney EUR', t.formatMoney(12450, 'EUR'), '€12,450');
eq('formatMoney GBP', t.formatMoney(1234567, 'GBP'), '£1,234,567');
eq('formatMoney unknown code', t.formatMoney(2500, 'BTC'), 'BTC 2,500');
eq('formatMoney small', t.formatMoney(999, 'USD'), '$999');
eq('formatMoney rounds', t.formatMoney(12450.7, 'USD'), '$12,451');
eq('groupThousands', t.groupThousands(1000000), '1,000,000');

// progress
const p1 = t.computeProgress({ raised: 12450, goal: 20000 });
eq('pct 12450/20000', p1.pct, 62.25);
eq('pctLabel 12450/20000', p1.pctLabel, '62%');

const p2 = t.computeProgress({ raised: 25000, goal: 20000 });
eq('clamp over 100 pct', p2.pct, 100);
eq('clamp over 100 label', p2.pctLabel, '100%');

const p3 = t.computeProgress({ raised: 500, goal: 0 });
eq('goal 0 -> 0 pct', p3.pct, 0);
eq('goal 0 -> 0 label', p3.pctLabel, '0%');

const p4 = t.computeProgress({ raised: 0, goal: 20000 });
eq('zero raised', p4.pct, 0);

// normalise + uri
const v = t.normalise({ campaign: 'Community Garden', raised: 12450, goal: 20000, currency: 'USD' });
eq('normalise campaign', v.campaign, 'Community Garden');
eq('normalise raisedLabel', v.raisedLabel, '$12,450');
eq('normalise goalLabel', v.goalLabel, '$20,000');
eq('normalise pctLabel', v.pctLabel, '62%');

const uri = t.overlayUri('https://s/thermo-overlay.html', v);
const parsed = new URL(uri);
eq('uri campaign round-trips', parsed.searchParams.get('campaign'), 'Community Garden');
eq('uri raised round-trips', parsed.searchParams.get('raised'), '$12,450');
eq('uri pct round-trips', parsed.searchParams.get('pct'), '62.25');

let pass = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}` + (c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`));
  if (c.ok) pass++;
}
const ok = pass === checks.length;
console.log(`\n${pass}/${checks.length} checks`);
console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
