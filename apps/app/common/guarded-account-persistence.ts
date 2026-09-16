export interface PersistedAccountIdentity {
  id: string;
}

/**
 * Durably adds an account created by a successful network registration.
 * Registration consumes the invite and creates membership before this helper
 * runs, so a superseding UI action may stop its connection but must never
 * erase the resulting account. If the attempt turns stale during the first
 * write, persist the latest in-memory list once more so concurrent account
 * mutations win without orphaning the registered membership.
 */
export async function persistAccountAdditionWhileCurrent<
  TAccount extends PersistedAccountIdentity,
>(args: {
  account: TAccount;
  isCurrent: () => boolean;
  readAccounts: () => TAccount[];
  commitAccounts: (accounts: TAccount[]) => void;
  persistAccounts: (accounts: TAccount[]) => Promise<void>;
}): Promise<boolean> {
  const withAccount = [
    ...args.readAccounts().filter((account) => account.id !== args.account.id),
    args.account,
  ];
  args.commitAccounts(withAccount);
  await args.persistAccounts(withAccount);

  if (args.isCurrent()) return true;

  await args.persistAccounts(args.readAccounts());
  return false;
}
