export type BrowserDecision = { tool: 'browser_control' | 'browser_permissions'; args: Record<string, unknown>; detail: string };
export declare function browserPayload(value: unknown): Record<string, unknown>;
export declare function resolveBrowserDecision(value: unknown, input: unknown): BrowserDecision;
export declare function performBrowserDecision(inventory: () => Promise<unknown>, dispatch: (decision: BrowserDecision) => Promise<unknown>, input: unknown, confirm: (detail: string) => Promise<boolean>): Promise<unknown>;
