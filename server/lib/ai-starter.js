'use strict';

/*
 * 3.0 "Set up my screens with AI": one sentence about a business → a starter set of 3–6 signs,
 * built from the Make-a-sign templates (lib/sign-templates.js). docs/private-ai.md.
 *
 * ⚠️ THE MODEL FILLS TYPED FIELDS, NEVER LAYOUT AND NEVER MARKUP. It is shown each template's field
 * schema and answers with values; every value is then checked against that schema here, and again
 * by validateValues when the sign is built — the same path a person's typing takes. What reaches a
 * screen is still a sign template's own layout with words in its fields.
 *
 * ⚠️ BUILT FOR SMALL LOCAL MODELS. A 3B–8B model on a school's own box gets the shape wrong often:
 * prose around the JSON, an array where an object belongs, a 90-character headline, a template that
 * does not exist. So the prompt is short and literal, a reply that yields too little is retried ONCE
 * with the specific problems named, and anything still wrong is DROPPED field by field rather than
 * failing the set. A partial, valid suggestion is useful; an error is not.
 *
 * ⚠️ WHAT THE MODEL IS NOT OFFERED. Templates whose required field is a fact the model cannot know
 * — a Wi-Fi password, a link to encode, a date to count down to, a person's name — are left out, and
 * `url`, colour, toggle and select fields are never offered at all. A model asked for a Wi-Fi
 * password invents one, and an invented password on the wall is worse than no sign.
 */

const signs = require('./sign-templates');
const { stripTags } = require('./strip-tags');

const MIN_SIGNS = 3;
const MAX_SIGNS = 6;
const MAX_DESCRIPTION = 400;

/*
 * The templates on offer and a one-line description of each field, for the model only (never shown
 * to a person, so not translated). Keys must exist in sign-templates.js; a test holds that.
 */
const OFFER = {
  specials: { use: 'menu board / daily specials', fields: { business: 'business name', title: 'headline', subtitle: 'one line under the headline', items: 'dishes or products: label = item name, value = price (leave value empty if no price was given)' } },
  sale: { use: 'a promotion or offer', fields: { big: 'a very short big number or word, e.g. "20%" or "2 for 1"', title: 'headline', details: 'details of the offer', cta: 'short call to action' } },
  hours: { use: 'opening hours', fields: { title: 'headline', rows: 'label = day or days, value = hours (or "Closed")', note: 'small print' } },
  welcome: { use: 'welcome at the entrance', fields: { business: 'business name', title: 'headline', message: 'a friendly message' } },
  event: { use: 'an event or regular happening', fields: { eyebrow: 'when, short', title: 'headline', details: 'details' } },
  announcement: { use: 'a notice', fields: { label: 'short label', title: 'headline', body: 'up to 5 short lines of text', footer: 'footer line' } },
  hiring: { use: 'recruitment', fields: { title: 'headline', roles: 'one job per line', apply: 'how to apply' } },
  closure: { use: 'a holiday closure', fields: { title: 'headline', dates: 'the dates', message: 'message', reopen: 'when you reopen' } },
  safety: { use: 'a safety or hygiene notice', fields: { label: 'band text', title: 'headline', body: 'up to 4 short instruction lines' } },
  reception: { use: 'a meeting room or reception', fields: { eyebrow: 'small heading', title: 'room or desk name', subtitle: 'subtitle', rows: 'label/value detail lines' } },
};
const OFFERED_TYPES = new Set(['text', 'multiline', 'rows']);

function offeredFields(tpl) {
  const hints = (OFFER[tpl.id] || {}).fields || {};
  return tpl.fields.filter((f) => OFFERED_TYPES.has(f.type) && !f.more && Object.prototype.hasOwnProperty.call(hints, f.key));
}

function schemaLine(tpl) {
  const o = OFFER[tpl.id];
  const fields = offeredFields(tpl).map((f) => {
    const kind = f.type === 'rows' ? `list of {"label","value"}, at most ${f.max_rows} (label <= 60 chars, value <= 30)`
      : f.type === 'multiline' ? `text, at most ${f.max_lines} lines, <= ${f.max} chars`
      : `text <= ${f.max} chars`;
    return `    "${f.key}"${f.required ? ' (required)' : ''}: ${kind} — ${o.fields[f.key]}`;
  });
  return `- "${tpl.id}" (${o.use}):\n${fields.join('\n')}`;
}

function systemPrompt() {
  const tpls = Object.keys(OFFER).map((id) => signs.getTemplate(id)).filter(Boolean);
  return [
    'You write the words for digital signs in a small organisation.',
    'Answer with ONLY one JSON object. No prose, no markdown, no code fences.',
    'The object must be exactly: {"signs":[{"template":"TEMPLATE_ID","values":{"FIELD":VALUE}}]}',
    `Suggest ${MIN_SIGNS} to ${MAX_SIGNS} signs, each with a DIFFERENT template, chosen to suit the description.`,
    'Use only these templates and only these fields. Plain text only: no HTML, no emoji, no URLs.',
    'Keep every value within its character limit. Use the same language as the description.',
    'Do not invent facts that were not given: no phone numbers, addresses, prices, dates or names.',
    'If a field would need a fact you do not have, leave it out.',
    '',
    'Templates:',
    ...tpls.map(schemaLine),
  ].join('\n');
}

function userPrompt(description) {
  return `Description: ${description}`;
}

/* ============================================================ validation */

// C0 controls and DEL; the template validator removes them too, this keeps lengths honest first.
const CTRL = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

/** Plain one-line text, or null if the model gave something that is not text. */
function cleanLine(v) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  return stripTags(v).replace(/\r\n?|\n/g, ' ').replace(CTRL, '').replace(/\s+/g, ' ').trim();
}

/** Shorten at a word boundary rather than mid-word; a model that ran a little long still helps. */
function fitLength(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,;:–-]+$/, '');
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/*
 * A sign's values. The asked-for shape is {"template","values":{...}}; qwen2.5 (14B and 32B) often
 * leaves the wrapper out and puts the fields beside "template". Without a `values` key the sign's
 * other keys ARE the values. A `values` that is there but is not an object is not repaired.
 */
function valuesOf(raw) {
  if (Object.prototype.hasOwnProperty.call(raw, 'values')) return isObj(raw.values) ? raw.values : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (k !== 'template') out[k] = v;
  return out;
}

/** {"hours": {...}, "sale": {...}}: an object keyed by template ids, each one a sign. */
function templateMap(o) {
  const keys = Object.keys(o);
  if (!keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(OFFER, k.trim().toLowerCase()) && isObj(o[k]))) return null;
  return keys.map((k) => ({ template: k, ...o[k] }));
}

/*
 * The list of sign objects in a reply, and which shape it came in (for the log). Accepted: the
 * asked-for {"signs":[...]}; a bare array; one sign object on its own; {"signs":{"hours":{...}}} or
 * {"hours":{...}} keyed by template; or an object whose ONE key holds the array ({"suggestions":[...]}).
 * Every sign then goes through validateProposal unchanged, so a lenient shape never means a
 * lenient value.
 */
function signListOf(parsed) {
  if (Array.isArray(parsed)) return { list: parsed, shape: 'array' };
  if (!isObj(parsed)) return { list: null, shape: 'not_object' };
  if (Array.isArray(parsed.signs)) return { list: parsed.signs, shape: 'signs' };
  if (isObj(parsed.signs)) {
    if (typeof parsed.signs.template === 'string') return { list: [parsed.signs], shape: 'signs_single' };
    const m = templateMap(parsed.signs);
    if (m) return { list: m, shape: 'signs_map' };
  }
  if (typeof parsed.template === 'string') return { list: [parsed], shape: 'single' };
  const m = templateMap(parsed);
  if (m) return { list: m, shape: 'map' };
  const keys = Object.keys(parsed);
  if (keys.length === 1 && Array.isArray(parsed[keys[0]])) return { list: parsed[keys[0]], shape: 'other_key' };
  return { list: null, shape: 'unrecognised' };
}

/**
 * One proposal from the model → {template, values, dropped} or {reject}. Every value is checked
 * against the template's schema; a value that fails is dropped (named in `dropped`), never repaired
 * into something the model did not say beyond trimming it to length.
 */
function validateProposal(raw, { brand = null, seen = new Set() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reject: 'not_an_object' };
  const id = typeof raw.template === 'string' ? raw.template.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(OFFER, id)) return { reject: 'unknown_template' };
  if (seen.has(id)) return { reject: 'duplicate_template' };
  const tpl = signs.getTemplate(id);
  if (!tpl) return { reject: 'unknown_template' };
  const src = valuesOf(raw);
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const values = {};
  const dropped = [];

  for (const f of offeredFields(tpl)) {
    if (!has(f.key)) continue;
    const v = src[f.key];
    if (f.type === 'text') {
      const s = cleanLine(v);
      if (s == null || !s) { dropped.push(f.key); continue; }
      values[f.key] = fitLength(s, f.max);
    } else if (f.type === 'multiline') {
      let lines = null;
      if (Array.isArray(v)) lines = v.map(cleanLine);
      else if (typeof v === 'string') lines = v.replace(/\r\n?/g, '\n').split('\n').map(cleanLine);
      if (!lines || lines.some((l) => l == null)) { dropped.push(f.key); continue; }
      lines = lines.filter(Boolean).slice(0, f.max_lines);
      if (!lines.length) { dropped.push(f.key); continue; }
      values[f.key] = fitLength(lines.join('\n'), f.max);
    } else if (f.type === 'rows') {
      if (!Array.isArray(v)) { dropped.push(f.key); continue; }
      const rows = [];
      for (const r of v.slice(0, f.max_rows)) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
        const label = cleanLine(r.label);
        const value = r.value == null ? '' : cleanLine(r.value);
        if (label == null || value == null || (!label && !value)) continue;
        rows.push({ label: fitLength(label, 60), value: fitLength(value, 30) });
      }
      if (!rows.length) { dropped.push(f.key); continue; }
      values[f.key] = rows;
    }
  }
  // Anything the model sent that is not an offered field (a colour, a url, a made-up key) is dropped.
  for (const k of Object.keys(src)) if (!offeredFields(tpl).some((f) => f.key === k)) dropped.push(k);

  // The brand kit wins over the model for the business name: it is a fact the workspace already gave.
  for (const f of tpl.fields) if (f.brand && brand && brand[f.brand]) values[f.key] = brand[f.brand];

  // The final word is the template's own validator, the one a person's form goes through.
  const { errors } = signs.validateValues(tpl, values, { brand });
  if (errors.some((e) => e.code === 'required')) return { reject: 'missing_required', template: id };
  if (errors.length) {
    for (const e of errors) { delete values[e.field]; dropped.push(e.field); }
    if (signs.validateValues(tpl, values, { brand }).errors.length) return { reject: 'invalid', template: id };
  }
  seen.add(id);
  return { template: id, values, dropped: [...new Set(dropped)].slice(0, 20) };
}

/** A whole reply → the valid proposals, and why the others were not. */
function validateReply(parsed, { brand = null } = {}) {
  const { list, shape } = signListOf(parsed);
  if (!list) return { proposals: [], problems: ['the reply was not {"signs":[...]}'], shape, rejects: [] };
  const seen = new Set();
  const proposals = [];
  const problems = [];
  const rejects = [];   // reason codes only, for the server log
  for (const raw of list.slice(0, MAX_SIGNS * 2)) {
    const r = validateProposal(raw, { brand, seen });
    if (r.reject) {
      problems.push(`${r.template || (raw && raw.template) || '?'}: ${r.reject}`);
      rejects.push(r.reject);
    } else proposals.push(r);
    if (proposals.length >= MAX_SIGNS) break;
  }
  return { proposals, problems, shape, rejects };
}

/*
 * Why one attempt gave nothing usable, for the server log. ⚠️ CODES AND COUNTS ONLY: never the
 * description, the prompt, the reply or a value from it (not even a template name the model made
 * up), because a private-AI customer chose that its words go nowhere else (lib/private-ai.js).
 */
function attemptSummary(answer, result) {
  if (!answer) return 'not asked';
  if (answer.error) return `error=${answer.code || 'unknown'}`;
  const counts = {};
  for (const r of result.rejects || []) counts[r] = (counts[r] || 0) + 1;
  const rej = Object.entries(counts).map(([k, n]) => `${k}x${n}`).join(',') || 'none';
  return `shape=${result.shape || '?'} valid=${result.proposals.length} rejected=${rej}`;
}

/**
 * Ask, validate, and ask once more if the answer was not enough. `ask(system, user)` is the model
 * call (lib/private-ai chatJson bound to a workspace), returning {parsed} or {error}.
 */
async function suggest({ description, brand = null, ask }) {
  const desc = cleanLine(description);
  if (!desc) return { error: 'Describe your business in a sentence first.', status: 400 };
  const text = desc.slice(0, MAX_DESCRIPTION);
  const system = systemPrompt();

  const first = await ask(system, userPrompt(text));
  if (first.error && first.code !== 'bad_json') return first;
  const firstResult = first.error ? { proposals: [], problems: ['the reply was not JSON'] } : validateReply(first.parsed, { brand });
  let result = firstResult;
  let retried = false;
  let second = null;
  let secondResult = null;

  if (result.proposals.length < MIN_SIGNS) {
    retried = true;
    const why = result.problems.slice(0, 6).join('; ') || 'too few valid signs';
    second = await ask(system, `${userPrompt(text)}\n\nYour previous answer could not be used (${why}). `
      + `Answer again with ONLY the JSON object, ${MIN_SIGNS} to ${MAX_SIGNS} signs, using only the listed templates and fields.`);
    if (!second.error) {
      const again = validateReply(second.parsed, { brand });
      secondResult = again;
      // Keep the better answer, plus anything new the second one adds.
      const best = again.proposals.length >= result.proposals.length ? again : result;
      const other = best === again ? result : again;
      const have = new Set(best.proposals.map((p) => p.template));
      result = {
        proposals: [...best.proposals, ...other.proposals.filter((p) => !have.has(p.template))].slice(0, MAX_SIGNS),
        problems: [...result.problems, ...again.problems],
      };
    }
  }
  if (!result.proposals.length) {
    console.warn(`[ai-starter] no usable signs: attempt 1 ${attemptSummary(first, firstResult)}; attempt 2 ${attemptSummary(second, secondResult)}`);
    return { error: 'The AI could not suggest usable signs this time. Try again, or describe the business a little differently.', status: 400, code: 'no_valid_signs' };
  }
  return { proposals: result.proposals, retried, problems: result.problems.length };
}

module.exports = { OFFER, MIN_SIGNS, MAX_SIGNS, systemPrompt, validateProposal, validateReply, signListOf, suggest, offeredFields };
