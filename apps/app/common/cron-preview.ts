/**
 * Cron preview helpers shared by the schedule pickers.
 *
 * A schedule is evaluated in its own IANA timezone (``scheduled_tasks.timezone``)
 * or, without one, in UTC — exactly as the scheduler fires it. The preview must
 * ask the gateway for that zone and say which zone the times are in; reading them
 * in the device's or the server's local clock shows the wrong hour.
 */

export function cronDescribeQuery(expression: string, count = 3, timezone?: string | null): string {
  const params = new URLSearchParams({ expression, count: String(count) });
  const zone = (timezone ?? '').trim();
  if (zone) params.set('timezone', zone);
  return params.toString();
}

/** Label for the zone the upcoming fires are shown in. */
export function previewZoneLabel(responseZone?: string | null, requestedZone?: string | null): string {
  return (responseZone || requestedZone || 'UTC').trim() || 'UTC';
}
