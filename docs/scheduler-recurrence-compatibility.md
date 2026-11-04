# Recurring schedule semantics

This change deliberately affects only recurrence kinds created by ScreenTinker: `DAILY`, `WEEKLY`, and `MONTHLY`.

| Case | Previous behavior | New behavior |
| --- | --- | --- |
| One-off end minute | Inclusive | Unchanged |
| Recurring end minute | Inclusive | Half-open (`end` is inactive) |
| Overnight recurrence | Never active | Anchored to the date on which it starts |
| `INTERVAL` | Parsed but ignored | Applied to daily, weekly, and monthly rules |
| Weekly without `BYDAY` | Active every day | Uses the weekday of `start_time` |
| Unknown stored frequency | Daily-like, end-inclusive fallback | Unchanged |

The evaluator still converts UTC to the device or wall timezone before applying these rules. Existing schedules should be reviewed before adopting this migration, especially schedules that intentionally relied on the inclusive recurring end minute or a weekly rule without `BYDAY`.
