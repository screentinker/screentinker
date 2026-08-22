// Hindi translations — INTENTIONALLY SKELETON.
//
// We have an active user in India. Rather than ship machine-quality Hindi that
// could read as unprofessional or get formality register / gendered verbs
// wrong, this file starts with only carefully scoped workflow translations;
// every other key falls back to English via the t() loader. Additional keys
// can be added after native review without any code change in views.
//
// Translation guidelines for whoever fills this in:
//   - Use formal आप register (this is B2B software, not consumer chat).
//   - Keep technical terms in English when borrowed (Playlist, YouTube, MIME)
//     — these are familiar to Indian users in their English form.
//   - Translate UI verbs (Save, Cancel, etc.) into proper Hindi.
//   - Test on the dashboard and content views first; those are wired to t().
//
// To add a key: copy from en.js and translate the value. Order doesn't matter;
// the loader merges over English fallback.
export default {
  'dashboard.select_all': 'सभी',
  'dashboard.invert_selection': 'चयन उलटें',
  'dashboard.cancel_selection': 'रद्द करें',
  'dashboard.add_to_group': 'समूह में जोड़ें',
  'dashboard.create_group_and_add': 'समूह बनाएं और जोड़ें',
};
