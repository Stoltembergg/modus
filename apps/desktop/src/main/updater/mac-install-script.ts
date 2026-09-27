/**
 * Detached /bin/sh script that swaps the app bundle after Modus quits. Positional args:
 *   $1 PID to wait for, $2 current bundle, $3 staged new bundle, $4 backup path,
 *   $5 `open` binary, $6 `xattr` binary, $7 max wait in 1/10 s, $8 lock directory,
 *   $9 failure marker file, $10 version being installed.
 * Exit codes (see MAC_INSTALL_EXIT_REASONS):
 *   0 installed
 *   3 app never quit (nothing changed; the app is still running)
 *   4 staged bundle missing, 5 current bundle could not be moved,
 *   8 an old backup could not be removed (nothing changed; old app relaunched)
 *   6 new bundle could not be moved in, 7 new version failed to launch (rolled back
 *     and old app relaunched)
 *   9 rollback could not clear the new bundle, 10 rollback could not move the backup
 *     back (the backup is left as is and launched from where it is)
 *   11 another install script holds the lock, 12 the lock could not be created
 *     (nothing changed)
 * Every error exit writes the failure marker ({"code","reason","version"} JSON) that
 * the service reads on the next start; success removes a stale marker.
 * Every `rm -rf` is checked: `mv` into an existing directory would nest the bundle
 * inside it instead of replacing it.
 */
export const MAC_INSTALL_SCRIPT = `set -u
pid="$1"; current="$2"; staged="$3"; backup="$4"; open_bin="$5"; xattr_bin="$6"; max_ticks="$7"
lock="$8"; marker="$9"; version="\${10}"
log() { echo "[modus-update] $*"; }
# Record why the install failed for the next app start, then exit with that code.
fail() {
  log "failed ($1 $2)"
  tmp="$marker.$$.tmp"
  if printf '{"code":%s,"reason":"%s","version":"%s"}\\n' "$1" "$2" "$version" > "$tmp"; then
    mv -f "$tmp" "$marker" 2>/dev/null || rm -f "$tmp"
  fi
  exit "$1"
}
# One install at a time: mkdir is atomic. Released on exit (stale locks are removed
# with the staging directory on the next app start).
if ! mkdir "$lock" 2>/dev/null; then
  if [ -d "$lock" ]; then fail 11 install-in-progress; fi
  fail 12 lock-unavailable
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# rm -rf, then fail if anything is left (e.g. an undeletable file inside).
remove_all() { rm -rf "$1" 2>/dev/null; [ ! -e "$1" ] && [ ! -L "$1" ]; }
# Put the backup back in place and relaunch it; fails with 9/10 (never nesting) if
# that is impossible, launching the backup from where it is.
restore() {
  if ! remove_all "$current"; then
    log "previous version kept at $backup"
    "$open_bin" "$backup" || true
    fail 9 rollback-remove-failed
  fi
  if ! mv "$backup" "$current"; then
    "$open_bin" "$backup" || true
    fail 10 rollback-move-failed
  fi
  log "restored previous version"
  "$open_bin" "$current" || true
}
ticks=0
while kill -0 "$pid" 2>/dev/null; do
  ticks=$((ticks + 1))
  if [ "$ticks" -gt "$max_ticks" ]; then fail 3 app-did-not-quit; fi
  sleep 0.1
done
if [ ! -d "$staged" ]; then "$open_bin" "$current" || true; fail 4 staged-missing; fi
if ! remove_all "$backup"; then "$open_bin" "$current" || true; fail 8 backup-not-removed; fi
if ! mv "$current" "$backup"; then "$open_bin" "$current" || true; fail 5 move-current-failed; fi
if [ -e "$current" ] || ! mv "$staged" "$current"; then restore; fail 6 move-new-failed; fi
"$xattr_bin" -dr com.apple.quarantine "$current" 2>/dev/null || true
if ! "$open_bin" "$current"; then restore; fail 7 launch-failed; fi
rm -f "$marker"
log "installed"
exit 0
`;

/** Reason keys written to the failure marker, by exit code. */
export const MAC_INSTALL_EXIT_REASONS: Record<number, string> = {
  3: "app-did-not-quit",
  4: "staged-missing",
  5: "move-current-failed",
  6: "move-new-failed",
  7: "launch-failed",
  8: "backup-not-removed",
  9: "rollback-remove-failed",
  10: "rollback-move-failed",
  11: "install-in-progress",
  12: "lock-unavailable",
};

/**
 * The script waits up to 10 minutes for the app to quit (MCP servers, terminals and
 * agents can make a quit slow). The service's 60 s watchdog only reports a retryable
 * failure in the UI; it does not stop this script.
 */
export const MAC_INSTALL_WAIT_TICKS = 6000;

export function macInstallScriptArgs(input: {
  pid: number;
  bundlePath: string;
  stagedAppPath: string;
  backupPath: string;
  lockPath: string;
  markerPath: string;
  version: string;
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
    input.lockPath,
    input.markerPath,
    input.version,
  ];
}
