(function (root) {
  'use strict';
  function read(raw) {
    var plan;
    try { plan = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (ignore) { return null; }
    if (!plan || plan.protocol_version !== 1 || !Array.isArray(plan.intervals) || !Array.isArray(plan.states)) return null;
    if (!Number(plan.valid_until_utc_ms) || !Number(plan.generated_at_utc_ms)) return null;
    return plan;
  }
  function select(raw, now) {
    var plan = read(raw), intervals, states, i, interval, state, j;
    if (!plan || now < Number(plan.generated_at_utc_ms) || now >= Number(plan.valid_until_utc_ms)) return { valid: false, plan: plan, interval: null, state: null };
    intervals = plan.intervals; states = plan.states;
    for (i = 0; i < intervals.length; i++) {
      interval = intervals[i];
      if (now < Number(interval.start_utc_ms) || now >= Number(interval.end_utc_ms)) continue;
      if (!interval.schedule_id) return { valid: true, plan: plan, interval: interval, state: null };
      for (j = 0; j < states.length; j++) {
        state = states[j];
        if (state && state.schedule_id === interval.schedule_id && state.payload) return { valid: true, plan: plan, interval: interval, state: state };
      }
      return { valid: true, plan: plan, interval: interval, state: null, error: 'Scheduled state is absent from the cached plan.' };
    }
    return { valid: true, plan: plan, interval: null, state: null, error: 'No interval covers the current time.' };
  }
  function dependencies(raw) {
    var plan = read(raw), out = [], seen = {}, states, i, j, items, item, key;
    if (!plan) return out;
    states = plan.states;
    for (i = 0; i < states.length; i++) {
      items = states[i] && states[i].payload && states[i].payload.assignments;
      if (!Array.isArray(items)) items = [];
      /* The inactive/default image is top-level in every payload. Include it
         alongside assignments so a future interval can render its standby
         image without requiring the CMS to be reachable. */
      if (states[i] && states[i].payload && states[i].payload.default_content) {
        items = items.concat([states[i].payload.default_content]);
      }
      for (j = 0; j < items.length; j++) {
        item = items[j];
        if (!item) continue;
        key = String(item.widget_id || item.content_id || '') + '|' + String(item.widget_rev || item.content_rev || '') + '|' + String(item.filepath || '');
        if (!seen[key]) { seen[key] = true; out.push(item); }
      }
    }
    return out;
  }
  root.STOfflinePlan = { read: read, select: select, dependencies: dependencies };
})(typeof window !== 'undefined' ? window : this);
