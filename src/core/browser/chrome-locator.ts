import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Universally locate an installed Chrome or Chromium executable across Linux, macOS, and Windows.
 *
 * This locator inspects standard system install paths and respects an explicit custom path
 * provided via configuration, avoiding any global mutable state.
 */
export function locateChromeExecutable(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const platformPaths: string[] = [];

  if (process.platform === 'linux') {
    platformPaths.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  } else if (process.platform === 'darwin') {
    platformPaths.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (process.platform === 'win32') {
    const programFiles = 'C:\\Program Files';
    const programFilesX86 = 'C:\\Program Files (x86)';
    const localAppData = path.join(os.homedir(), 'AppData', 'Local');

    platformPaths.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Chromium', 'Application', 'chrome.exe')
    );
  }

  for (const candidate of platformPaths) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Continue search on permission or filesystem access errors
    }
  }

  return null;
}
