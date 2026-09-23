import { loadConfig } from './config';
import { SettingsStore } from './settings';

// Separate from the web process: remains usable when duplicate rows prevent sign-in.
new SettingsStore(loadConfig(), {}).audit().then((report) => {
  console.log(JSON.stringify(report, null, 2));
  if (report.duplicates.length) process.exitCode = 1;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Settings audit failed');
  process.exitCode = 1;
});
