// The members of `SettingsHost` that the settings suites do not each care about, answered
// the way an idle, freshly loaded plugin would. Spread into each suite's own fake host, so a
// member added to the interface is one edit here rather than one per suite.
//
// `loadOverview` answers 404 by default — a control plane that predates the route — which
// hides the Agents section and makes no other change to the pane: the suites written before
// that section existed see the pane they were written against.

import type { OverviewResult } from "../overview.ts";
import type { SkippedFile } from "../sync/status.ts";

export const settingsHostDefaults = () => ({
  skippedFiles: (): readonly SkippedFile[] => [],
  loadOverview: async (): Promise<OverviewResult> => ({ status: "absent" }),
  now: () => 0,
  openInBrowser: (_url: string): void => {},
  reopenPairingPage: (): boolean => true,
  cancelPairing: (): void => {},
  retrySyncing: (): void => {},
});
