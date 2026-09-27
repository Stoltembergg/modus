/**
 * The GitHub repository whose Releases publish Modus: used by electron-builder's
 * `publish` config (written into app-update.yml) and by the in-app updater's download
 * URL allowlist. No Electron or Node imports: electron-builder.config.ts loads this
 * file through jiti at packaging time.
 */
export const RELEASE_REPO = { owner: "stoltembergg-png", repo: "modus" } as const;
