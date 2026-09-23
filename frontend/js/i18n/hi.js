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
  // Display power schedules (the weekly BACKLIGHT clock). ⚠️ The copy deliberately avoids saying
  // the device is powered off — it is not, and an operator who believes it is will use this wrong.
  // See frontend/js/components/power-schedule-editor.js.
  'power.section_title': 'स्क्रीन बंद करने का शेड्यूल',
  'power.enable': 'यह शेड्यूल लागू करें',
  'power.explainer': 'बैकलाइट बचाने के लिए साप्ताहिक शेड्यूल पर स्क्रीन बंद करता है। प्लेयर चलता रहता है, इसलिए कंटेंट, अपडेट और रिमोट कंट्रोल काम करते रहते हैं — इससे डिवाइस बंद नहीं होता।',
  'power.off_from': 'स्क्रीन बंद',
  'power.on_at': 'वापस चालू',
  'power.add_window': 'समय जोड़ें',
  'power.remove_window': 'यह समय हटाएँ',
  'power.remove_schedule': 'शेड्यूल हटाएँ',
  'power.save': 'शेड्यूल सहेजें',
  'power.no_windows': 'अभी कोई समय तय नहीं — स्क्रीन चालू रहेगी।',
  'power.no_days': 'कोई दिन नहीं',
  'power.overnight': '(रात भर)',
  'power.crosses_midnight': 'यह समय आधी रात के बाद अगली सुबह तक चलता है।',
  'power.unsupported': 'कुछ स्क्रीन अपने आप बंद नहीं हो सकतीं और इस शेड्यूल को अनदेखा करेंगी। आप फिर भी इसे सहेज सकते हैं।',
  'power.inherited_from_group': 'यह स्क्रीन अपने ग्रुप का शेड्यूल मान रही है। यहाँ सहेजने पर केवल इसी स्क्रीन के लिए बदलेगा।',
  'power.state.on': 'स्क्रीन चालू',
  'power.state.scheduled_off': 'शेड्यूल के अनुसार बंद',
  'power.next_off': '{time} बजे बंद होगी',
  'power.next_on': '{time} बजे चालू होगी',
  'power.preset.weeknights': 'कार्यदिवस 22:00–06:00',
  'power.preset.everynight': 'हर रात 22:00–06:00',
  'power.preset.weekends': 'पूरा सप्ताहांत',
  'power.saved': 'शेड्यूल सहेजा गया',
  'power.save_failed': 'शेड्यूल सहेजा नहीं जा सका',
  'power.day.sun': 'रवि',
  'power.day.mon': 'सोम',
  'power.day.tue': 'मंगल',
  'power.day.wed': 'बुध',
  'power.day.thu': 'गुरु',
  'power.day.fri': 'शुक्र',
  'power.day.sat': 'शनि',

  'dashboard.select_all': 'सभी',
  'dashboard.invert_selection': 'चयन उलटें',
  'dashboard.cancel_selection': 'रद्द करें',
  'dashboard.add_to_group': 'समूह में जोड़ें',
  'dashboard.create_group_and_add': 'समूह बनाएं और जोड़ें',
  // --- 2.0.1: शुरुआती चेकलिस्ट, नया क्या है ---
  'gs.playlist.cta_here': 'सामग्री जोड़ें',
  'gs.assign.desc': 'जिस स्क्रीन पर सामग्री चलानी है उसे खोलें, Playlist पर क्लिक करें, अपना लेआउट चुनें; अगर पूरी स्क्रीन का उपयोग नहीं कर रहे हैं तो चुनें कि सामग्री कहाँ चले, और Publish पर क्लिक करें।',
  'gs.assign.cta_here': 'प्लेलिस्ट चुनें',
  'whatsnew.title': '{version} में नया क्या है',
  'whatsnew.dismiss': 'बंद करें',
  'whatsnew.full_notes': 'पूरी जानकारी',
  'whatsnew.history_title': 'नया क्या है',
  'whatsnew.version_line': '{version} — {date}',
  'whatsnew.version_current': '{version} — {date} (वर्तमान में चल रहा)',
  'onboarding.step.done.assign_label': 'इस स्क्रीन पर क्या चलना चाहिए?',
  'onboarding.step.done.assign_none': 'अभी कुछ नहीं',
  'onboarding.toast.playlist_assigned': 'प्लेलिस्ट असाइन कर दी गई',
  'onboarding.toast.assign_failed': 'वह प्लेलिस्ट असाइन नहीं की जा सकी',
  'onboarding.toast.publish_failed': 'प्लेलिस्ट प्रकाशित नहीं हो सकी, इसलिए अभी कुछ नहीं चलेगा',
};
