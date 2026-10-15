'use strict';

/*
 * "Set up my screens with AI": the reply parser, against recorded-STYLE answers from local models
 * (qwen2.5 14B / 32B on Ollama answered like these and the user saw "could not suggest usable
 * signs"; gpt-oss:20b answered in the asked-for shape). No network and no model: the replies are
 * strings, run through the same extractJson the real chat call uses.
 *
 * The other half matters as much: a lenient SHAPE never means a lenient VALUE. Every sign still
 * goes through validateProposal, so garbage is still refused.
 */
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-aistarter-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-ai-starter';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractJson } = require('../lib/private-ai');
const starter = require('../lib/ai-starter');
const signs = require('../lib/sign-templates');

const HOURS = { template: 'hours', values: { title: 'Opening hours', rows: [{ label: 'Mon-Fri', value: '7:00 - 17:00' }] } };
const WELCOME = { template: 'welcome', values: { title: 'Welcome in', message: 'Fresh bread every morning' } };
const SALE = { template: 'sale', values: { big: '2 for 1', title: 'Pastry offer', details: 'Every afternoon' } };
const flat = (s) => ({ template: s.template, ...s.values });   // the sign without its `values` wrapper

// [name, reply text as the model sent it]
const RECORDED = [
  ['prose and a ```json fence around the asked-for object',
    'Sure! Here are some signs for your bakery:\n\n```json\n' + JSON.stringify({ signs: [HOURS, WELCOME, SALE] }, null, 2) + '\n```\n\nLet me know if you want changes.'],
  ['no `values` wrapper: fields beside "template"',
    JSON.stringify({ signs: [flat(HOURS), flat(WELCOME), flat(SALE)] }, null, 2)],
  ['a bare array of unwrapped signs inside a fence',
    '```\n' + JSON.stringify([flat(HOURS), flat(WELCOME), flat(SALE)]) + '\n```'],
  ['trailing commas',
    '{\n  "signs": [\n    {"template": "hours", "values": {"title": "Opening hours", "rows": [{"label": "Mon-Fri", "value": "7:00 - 17:00"},],},},\n'
    + '    {"template": "welcome", "values": {"title": "Welcome in", "message": "Fresh bread every morning",}},\n'
    + '    {"template": "sale", "values": {"big": "2 for 1", "title": "Pastry offer", "details": "Every afternoon"}},\n  ],\n}'],
  ['keyed by template id',
    JSON.stringify({ hours: HOURS.values, welcome: WELCOME.values, sale: SALE.values })],
  ['"signs" keyed by template id, unwrapped',
    JSON.stringify({ signs: { hours: HOURS.values, welcome: WELCOME.values, sale: SALE.values } })],
  ['a stray bracket in the prose before the JSON',
    'I made [3] signs for you, see below.\n' + JSON.stringify({ signs: [HOURS, WELCOME, SALE] })],
  ['a different single wrapper key',
    JSON.stringify({ suggestions: [HOURS, WELCOME, SALE] })],
  ['the closing brace never came (truncated), the array is whole',
    '{"signs": ' + JSON.stringify([HOURS, WELCOME, SALE])],
];

for (const [name, reply] of RECORDED) {
  test(`starter parse: ${name}`, () => {
    const parsed = extractJson(reply);
    assert.notEqual(parsed, undefined, 'some JSON was found');
    const { proposals } = starter.validateReply(parsed, {});
    assert.deepEqual(proposals.map((p) => p.template), ['hours', 'welcome', 'sale']);
    for (const p of proposals) {
      assert.deepEqual(signs.validateValues(signs.getTemplate(p.template), p.values, {}).errors, [], `${p.template} validates`);
    }
    assert.equal(proposals[0].values.title, 'Opening hours');
    assert.deepEqual(proposals[0].values.rows, [{ label: 'Mon-Fri', value: '7:00 - 17:00' }]);
    assert.equal(proposals[2].values.big, '2 for 1');
  });
}

test('starter parse: a single sign on its own is one sign', () => {
  const { proposals } = starter.validateReply(extractJson('Here:\n' + JSON.stringify(flat(HOURS))), {});
  assert.deepEqual(proposals.map((p) => p.template), ['hours']);
});

test('⚠️ starter parse: a lenient shape is not a lenient value — garbage is still refused', () => {
  const garbage = [
    { template: 'wifi', network: 'Guest', password: 'invented123' },     // not offered
    { template: 'hours', values: 'Opening hours 7-5' },                   // `values` there but not an object: not repaired
    { template: 'sale', title: 'Offer' },                                 // missing required "big"
    { template: 'event', title: { text: 'x' } },                          // required title is not text
    { template: 'nope', title: 'x' },
  ];
  for (const reply of [JSON.stringify({ signs: garbage }), JSON.stringify(garbage), JSON.stringify(garbage) + ',']) {
    const { proposals, rejects } = starter.validateReply(extractJson(reply), {});
    assert.deepEqual(proposals, [], reply);
    assert.deepEqual(rejects, ['unknown_template', 'missing_required', 'missing_required', 'missing_required', 'unknown_template']);
  }
  // Unoffered fields beside "template" are dropped exactly as inside `values`.
  const w = starter.validateProposal({ template: 'welcome', title: '<b>Hi</b>', bg: '#f00', url: 'https://evil.example' });
  assert.equal(w.values.title, 'Hi');
  assert.ok(!('bg' in w.values) && !('url' in w.values));
  assert.ok(w.dropped.includes('bg') && w.dropped.includes('url'));
  // Shapes that are not a list of signs at all.
  for (const reply of ['{"signs": "I cannot do that"}', '{"a": 1, "b": [1]}', '[1, 2, 3]', 'no json here', '{"signs": [1,]']) {
    const parsed = extractJson(reply);
    const r = parsed === undefined ? { proposals: [] } : starter.validateReply(parsed, {});
    assert.deepEqual(r.proposals, [], reply);
  }
});

test('extractJson: trailing commas only — a comma inside a string is left alone, and nothing else is repaired', () => {
  assert.deepEqual(extractJson('{"a": "x, }", "b": [1, 2,],}'), { a: 'x, }', b: [1, 2] });
  assert.equal(extractJson("{'a': 1}"), undefined, 'single quotes are not JSON and are not guessed at');
  assert.equal(extractJson('{"a": 1 "b": 2}'), undefined);
});

function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  return Promise.resolve().then(fn).finally(() => Object.assign(console, orig)).then((r) => ({ r, lines }));
}

test('suggest: an unparseable first answer is retried once with a corrective instruction, and the second is used', async () => {
  const users = [];
  const replies = ['Sure! {signs: [hours, welcome]}', '```json\n' + JSON.stringify({ signs: [flat(HOURS), flat(WELCOME), flat(SALE)] }) + '\n```'];
  const ask = async (system, user) => {
    users.push(user);
    const parsed = extractJson(replies[users.length - 1]);
    return parsed === undefined ? { error: 'The AI did not answer with usable JSON.', status: 400, code: 'bad_json' } : { parsed };
  };
  const out = await starter.suggest({ description: 'A small bakery', ask });
  assert.equal(users.length, 2);
  assert.match(users[1], /previous answer could not be used/);
  assert.equal(out.retried, true);
  assert.deepEqual(out.proposals.map((p) => p.template), ['hours', 'welcome', 'sale']);
});

test('⚠️ suggest: still unusable → the same user-facing error, and the server log says why without any content', async () => {
  const replies = ['not json, but it mentions sourdough', JSON.stringify({ signs: [{ template: 'sale', title: 'Sourdough offer' }, { template: 'made-up-sourdough' }] })];
  let n = 0;
  const ask = async () => {
    const parsed = extractJson(replies[n++]);
    return parsed === undefined ? { error: 'x', status: 400, code: 'bad_json' } : { parsed };
  };
  const { r, lines } = await capture(() => starter.suggest({ description: 'A sourdough bakery in Leeds', ask }));
  assert.equal(r.code, 'no_valid_signs');
  assert.match(r.error, /could not suggest usable signs/);
  const log = lines.join('\n');
  assert.match(log, /\[ai-starter\] no usable signs: attempt 1 error=bad_json; attempt 2 shape=signs valid=0 rejected=missing_requiredx1,unknown_templatex1/);
  assert.ok(!/sourdough|leeds|offer/i.test(log), 'no description, prompt, reply or value reaches the log');
});
