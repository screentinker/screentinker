/*
 * Template translations in the dashboard — the pure half of views/templates.js.
 *
 * A template package may carry locales/<lang>.json (validated by server/lib/templates/package.js);
 * the server passes ONE language of it along as `tpl.i18n = { <lang>: {...} }` when the dashboard
 * asks with ?lang=. English stays in the manifest and is the fallback for every missing string.
 *
 * ⚠️ THESE ARE DISPLAY STRINGS ONLY. Nothing here changes a param's name, type, option VALUES or
 * limits — those are the manifest's — and every string returned is still third-party text that the
 * view must pass through esc(), exactly like the English it replaces.
 *
 * ⚠️ A TRANSLATED DEFAULT IS FOR A NEW WIDGET ONLY. `initialValues` decides it: a value that was
 * saved (or is in a pending draft) is never replaced, and the screen's language param is never set
 * from the dashboard's — an empty locale means "the screen's own", and that is what it stays.
 */

/** The translation entry for `lang`, or null. */
export function translationFor(tpl, lang) {
  const all = tpl && tpl.i18n;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  const tr = all[lang];
  return tr && typeof tr === 'object' && !Array.isArray(tr) ? tr : null;
}

const strOr = (v, dflt) => (typeof v === 'string' && v !== '' ? v : dflt);

export function localName(tpl, lang) {
  const tr = translationFor(tpl, lang);
  return strOr(tr && tr.name, tpl ? tpl.name : '');
}

export function localDescription(tpl, lang) {
  const tr = translationFor(tpl, lang);
  return strOr(tr && tr.description, tpl ? (tpl.description || '') : '');
}

/**
 * The params with labels, help and option labels in `lang` where translated. Each returned param
 * is a copy; `localDefault` is set only on text/textarea params that have a translated default.
 */
export function localParams(tpl, lang) {
  const params = tpl && Array.isArray(tpl.params) ? tpl.params : [];
  const tr = translationFor(tpl, lang);
  const tp = tr && tr.params && typeof tr.params === 'object' ? tr.params : {};
  return params.map((p) => {
    const t = Object.prototype.hasOwnProperty.call(tp, p.name) && tp[p.name] && typeof tp[p.name] === 'object' ? tp[p.name] : null;
    if (!t) return p;
    const out = { ...p, label: strOr(t.label, p.label), help: strOr(t.help, p.help) };
    if (Array.isArray(p.options) && t.options && typeof t.options === 'object') {
      out.options = p.options.map((o) => (Object.prototype.hasOwnProperty.call(t.options, o.value)
        ? { ...o, label: strOr(t.options[o.value], o.label) } : o));
    }
    if ((p.type === 'text' || p.type === 'textarea') && typeof t.default === 'string' && t.default !== '') {
      out.localDefault = t.default;
    }
    return out;
  });
}

/**
 * The starting values of the Use/Edit form. `initialValues` (a saved widget's values or a pending
 * draft) always wins; otherwise a NEW widget gets the translated default where there is one, then
 * the manifest default. Editing (`isNew` false) never uses a translated default.
 */
export function initialFormValues(params, initialValues, { isNew = true } = {}) {
  const values = {};
  for (const p of params) {
    if (initialValues && Object.prototype.hasOwnProperty.call(initialValues, p.name)) values[p.name] = initialValues[p.name];
    else if (isNew && p.localDefault !== undefined) values[p.name] = p.localDefault;
    else if (p.default !== undefined) values[p.name] = p.default;
    else values[p.name] = p.type === 'checkbox' ? false : '';
  }
  return values;
}

/** `?lang=xx` for the template endpoints, or '' for English (the manifest already is English). */
export function langQuery(lang) {
  return typeof lang === 'string' && /^[a-z]{2}$/.test(lang) && lang !== 'en' ? `?lang=${lang}` : '';
}
