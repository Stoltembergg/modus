/**
 * Detached /bin/sh script that swaps the app bundle after Modus quits. Positional args:
 *   $1 PID to wait for, $2 current bundle, $3 staged new bundle, $4 backup path,
 *   $5 `open` binary, $6 `xattr` binary, $7 max wait in 1/10 s.
 * Exit codes:
 *   0 installed
 *   3 app never quit (nothing changed)
 *   4 staged bundle missing, 5 current bundle could not be moved,
 *   8 an old backup could not be removed (nothing changed; old app relaunched)
 *   6 new bundle could not be moved in, 7 new version failed to launch (rolled back)
 *   9 rollback could not clear the new bundle, 10 rollback could not move the backup
 *     back (the backup is left as is and launched from where it is)
 * Every `rm -rf` is checked: `mv` into an existing directory would nest the bundle
 * inside it instead of replacing it.
 */
export const MAC_INSTALL_SCRIPT = `set -u
pid="$1"; current="$2"; staged="$3"; backup="$4"; open_bin="$5"; xattr_bin="$6"; max_ticks="$7"
log() { echo "[modus-update] $*"; }
# rm -rf, then fail if anything is left (e.g. an undeletable file inside).
remove_all() { rm -rf "$1" 2>/dev/null; [ ! -e "$1" ] && [ ! -L "$1" ]; }
# Put the backup back in place; exits with 9/10 (never nesting) if that is impossible.
restore() {
  if ! remove_all "$current"; then
    log "rollback failed: could not remove the new bundle; previous version kept at $backup"
    "$open_bin" "$backup" || true
    exit 9
  fi
  if ! mv "$backup" "$current"; then
    log "rollback failed: could not move the backup back"
    "$open_bin" "$backup" || true
    exit 10
  fi
  log "restored previous version"
  "$open_bin" "$current" || true
}
ticks=0
while kill -0 "$pid" 2>/dev/null; do
  ticks=$((ticks + 1))
  if [ "$ticks" -gt "$max_ticks" ]; then log "app did not quit; update skipped"; exit 3; fi
  sleep 0.1
done
if [ ! -d "$staged" ]; then log "staged bundle missing"; "$open_bin" "$current" || true; exit 4; fi
if ! remove_all "$backup"; then log "could not remove old backup"; "$open_bin" "$current" || true; exit 8; fi
if ! mv "$current" "$backup"; then log "could not move current bundle"; "$open_bin" "$current" || true; exit 5; fi
if [ -e "$current" ] || ! mv "$staged" "$current"; then log "could not move new bundle"; restore; exit 6; fi
"$xattr_bin" -dr com.apple.quarantine "$current" 2>/dev/null || true
if ! "$open_bin" "$current"; then log "could not launch new version"; restore; exit 7; fi
log "installed"
exit 0
`;

export const MAC_INSTALL_WAIT_TICKS = 600;

export function macInstallScriptArgs(input: {
  pid: number;
  bundlePath: string;
  stagedAppPath: string;
  backupPath: string;
  openBin?: string;
  xattrBin?: string;
  maxWaitTicks?: number;
}): string[] {
  return [
    "-c",
    MAC_INSTALL_SCRIPT,
    "modus-update",
    String(input.pid),
    input.bundlePath,
    input.stagedAppPath,
    input.backupPath,
    input.openBin ?? "/usr/bin/open",
    input.xattrBin ?? "/usr/bin/xattr",
    String(input.maxWaitTicks ?? MAC_INSTALL_WAIT_TICKS),
  ];
}
