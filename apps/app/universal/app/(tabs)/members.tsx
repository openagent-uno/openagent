/**
 * /members → /settings redirect.
 *
 * The standalone Members tab moved into Settings → Members. This
 * stub stays so any cached deep link or in-app navigation that
 * still targets ``/members`` lands on the right place instead of
 * 404ing. Remove after one release once the old route can't be
 * referenced anywhere.
 */

import { Redirect } from 'expo-router';

export default function MembersRedirect() {
  return <Redirect href="/(tabs)/settings" />;
}
