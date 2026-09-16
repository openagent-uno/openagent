/**
 * Redirect stub: /automations → /workflows.
 *
 * The old placeholder has been replaced by the real Workflows tab.
 * This file exists so saved links and deep links keep resolving for
 * one release cycle. Safe to delete afterwards.
 */

import { Redirect } from 'expo-router';

export default function AutomationsRedirect() {
  return <Redirect href="/workflows" />;
}
