/** Version + build metadata. Kept in one place so the updater can trust it. */
export const APP_VERSION = '1.0.11';
export const APP_NAME = 'Epic Claims';
export const APP_ID = 'com.diy23.epic-claims';
export const REPO = 'DIY23/epic-claims';
export const BUILD_NODE = process.version.replace(/^v/, '');

export interface BuildInfo {
  version: string;
  node: string;
  platform: string;
  arch: string;
  buildTime: string;
}

export function buildInfo(): BuildInfo {
  return {
    version: APP_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    buildTime: process.env.EPIC_CLAIMS_BUILD_TIME ?? 'dev',
  };
}
