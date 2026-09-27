/**
 * Detached /bin/sh script that swaps the app bundle after Modus quits. Positional args:
 *   $1 PID to wait for, $2 current bundle, $3 staged new bundle, $4 backup path,
 *   $5 `open` binary, $6 `xattr` binary, $7 max wait in 1/10 s.
 * Exit codes: 0 ok, 3 app never quit (nothing changed), 4-7 failed and rolled back.
 * Every failure after the old bundle moved restores it and relaunches it.
 */
export const MAC_INSTALL_SCRIPT = `set -u
pid="$1"; current="$2"; staged="$3"; backup="$4"; open_bin="$5"; xattr_bin="$6"; max_ticks="$7"
log() { echo "[modus-update] $*"; }
restore() {
  rm -rf "$current"
  if mv "$backup" "$current"; then log "restored previous version"; else log "restore failed"; fi
  "$open_bin" "$current" || true
}
ticks=0
while kill -0 "$pid" 2>/dev/null; do
  ticks=$((ticks + 1))
  if [ "$ticks" -gt "$max_ticks" ]; then log "app did not quit; update skipped"; exit 3; fi
  sleep 0.1
done
if [ ! -d "$staged" ]; then log "staged bundle missing"; "$open_bin" "$current" || true; exit 4; fi
rm -rf "$backup"
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
