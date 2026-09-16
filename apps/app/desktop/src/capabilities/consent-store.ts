import Store from 'electron-store';

export const CAPABILITY_CONSENT_VERSION = 1;

export interface CapabilityConsent {
  enabled: boolean;
  version: number;
  updatedAt: string | null;
}

interface CapabilityConsentState extends CapabilityConsent {
  // Fail-closed tombstone kept separately from the broker's canonical grant.
  // If emergency revocation cannot reach the broker, a Desktop restart must
  // continue revoking instead of trusting the previous `enabled=true` value.
  emergencyRevokePending: boolean;
}

/**
 * Main-process-only UI cache of the host's canonical device consent.
 *
 * The stand-alone host owns the shared Desktop/CLI grant. This cache is never
 * pushed into the host at boot and is never used to authorize execution; it
 * only avoids a misleading blank state while the host status is loading.
 * Keeping it out of the generic renderer store also prevents renderer code
 * from forging even that cached state.
 */
export class CapabilityConsentStore {
  private readonly store = new Store<CapabilityConsentState>({
    name: 'openagent-device-capabilities',
    defaults: {
      enabled: false,
      version: CAPABILITY_CONSENT_VERSION,
      updatedAt: null,
      emergencyRevokePending: false,
    },
  });

  get(): CapabilityConsent {
    const version = this.store.get('version', CAPABILITY_CONSENT_VERSION);
    // A future consent wording/scope change must require a fresh grant.
    const enabled = version === CAPABILITY_CONSENT_VERSION && this.store.get('enabled', false);
    return {
      enabled,
      version: CAPABILITY_CONSENT_VERSION,
      updatedAt: this.store.get('updatedAt', null),
    };
  }

  cacheCanonical(enabled: boolean, version = CAPABILITY_CONSENT_VERSION, updatedAt?: string | null): CapabilityConsent {
    const consent: CapabilityConsent = {
      enabled,
      version,
      updatedAt: updatedAt ?? new Date().toISOString(),
    };
    this.store.set(consent);
    return consent;
  }

  getEmergencyRevokePending(): boolean {
    return this.store.get('emergencyRevokePending', false);
  }

  setEmergencyRevokePending(pending: boolean): void {
    this.store.set('emergencyRevokePending', pending);
  }
}
