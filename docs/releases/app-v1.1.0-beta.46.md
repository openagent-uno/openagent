# OpenAgent App 1.1.0 beta 46

- Scheduled: the "Next runs" preview of a task is computed in the task's own
  timezone and shows each run with its offset and the timezone used, so it
  matches the task's real next run (with Server beta49, whose
  `/api/cron/describe` accepts `timezone`). Before, a daily 09:00 task in a
  non-UTC timezone could preview at another hour.
- Markdown: underscores inside a word stay literal (CommonMark), so names such
  as `forum_activity` or environment-variable names no longer render with
  italic fragments, in user and assistant messages alike.
- Tests and examples use neutral names.

The app keeps Host Tools beta18, the existing application ID, local profiles and
device consent.
