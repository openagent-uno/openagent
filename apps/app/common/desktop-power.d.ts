/** Desktop-only power control contract, shared without a runtime dependency. */
export interface DesktopPowerStatus {
  preventSleep: boolean;
  closedLid: boolean;
  active: boolean;
  blocking: boolean;
  lidStatus: 'unsupported' | 'setup-required' | 'approval-required' | 'ready' | 'active' | 'paused' | 'error';
}

export interface DesktopPowerAPI {
  getPowerStatus(): Promise<DesktopPowerStatus>;
  setPowerPreferences(input: { preventSleep?: boolean; closedLid?: boolean }): Promise<DesktopPowerStatus>;
  reportSessionActivity(accountId: string | null, active: boolean): void;
}
