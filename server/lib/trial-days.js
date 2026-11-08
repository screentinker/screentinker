'use strict';

// Length of the hosted free trial, in days. Its own module so code that runs during database
// migrations (lib/trial-screens.js backfill) can read it without requiring middleware/subscription.js,
// which requires the database module that is still loading at that point.
module.exports = { TRIAL_DAYS: 14 };
