import { describe, expect, it } from "vitest";
import {
  isAllowedDownloadRedirect,
  isAllowedReleaseAssetUrl,
  isArm64Mac,
  isNewerStableVersion,
  macInstallBlocker,
  releaseAssetUrl,
  releasePageUrl,
  resolveUpdatePolicy,
  selectMacZip,
} from "./update-policy";

const packaged = { isPackaged: true, version: "1.2.3", platform: "win32", env: {} };

describe("resolveUpdatePolicy", () => {
  it("is a no-op in development", () => {
    expect(resolveUpdatePolicy({ ...packaged, isPackaged: false })).toEqual({
      enabled: false,
      reason: "development",
    });
  });

  it("disables beta and other pre-release versions", () => {
    for (const version of ["1.3.0-beta.1", "1.3.0-beta", "1.3.0-rc.1", "1.3.0+build"]) {
      expect(resolveUpdatePolicy({ ...packaged, version })).toEqual({
        enabled: false,
        reason: "prerelease-version",
      });
    }
  });

  it("installs in place on Windows, macOS and Linux AppImage", () => {
    expect(resolveUpdatePolicy(packaged)).toMatchObject({ enabled: true, installMode: "auto" });
    expect(resolveUpdatePolicy({ ...packaged, platform: "darwin" })).toMatchObject({
      enabled: true,
      installMode: "auto",
    });
    expect(
      resolveUpdatePolicy({
        ...packaged,
        platform: "linux",
        env: { APPIMAGE: "/a/Modus.AppImage" },
      }),
    ).toMatchObject({ enabled: true, installMode: "auto" });
  });

  it("only offers the release page on Linux deb installs (no APPIMAGE)", () => {
    expect(resolveUpdatePolicy({ ...packaged, platform: "linux", env: {} })).toEqual({
      enabled: true,
      platform: "linux",
      installMode: "download-page",
    });
  });

  it("disables unsupported platforms", () => {
    expect(resolveUpdatePolicy({ ...packaged, platform: "freebsd" })).toMatchObject({
      enabled: false,
    });
  });
});

describe("isNewerStableVersion", () => {
  it("only accepts strictly newer stable versions", () => {
    expect(isNewerStableVersion("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerStableVersion("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerStableVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerStableVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerStableVersion("1.2.2", "1.2.3")).toBe(false);
    expect(isNewerStableVersion("0.9.0", "1.0.0")).toBe(false);
    expect(isNewerStableVersion("1.3.0-beta.1", "1.2.3")).toBe(false);
    expect(isNewerStableVersion("v1.3.0", "1.2.3")).toBe(false);
  });
});

describe("release URLs", () => {
  it("builds official release page and asset URLs", () => {
    expect(releasePageUrl("1.2.3")).toBe(
      "https://github.com/stoltembergg-png/modus/releases/tag/v1.2.3",
    );
    expect(releasePageUrl()).toBe("https://github.com/stoltembergg-png/modus/releases/latest");
    expect(releaseAssetUrl("1.2.3", "Modus-1.2.3-mac-arm64.zip")).toBe(
      "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus-1.2.3-mac-arm64.zip",
    );
    expect(() => releaseAssetUrl("1.2.3", "../evil.zip")).toThrow();
    expect(() => releaseAssetUrl("1.2.3", "a/b.zip")).toThrow();
    expect(() => releaseAssetUrl("1.2.3", ".hidden")).toThrow();
    expect(() => releaseAssetUrl("1.2.3-beta.1", "x.zip")).toThrow();
  });

  it("allowlists only official release download URLs", () => {
    const ok = "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip";
    expect(isAllowedReleaseAssetUrl(ok)).toBe(true);
    expect(isAllowedReleaseAssetUrl(ok, "1.2.3")).toBe(true);
    expect(isAllowedReleaseAssetUrl(ok, "1.2.4")).toBe(false);
    for (const bad of [
      "http://github.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip",
      "https://evil.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip",
      "https://github.com.evil.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip",
      "https://github.com/brandlll-lee/modus/releases/download/v1.2.3/Modus.zip",
      "https://github.com/stoltembergg-png/modus-evil/releases/download/v1.2.3/Modus.zip",
      "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3/x/Modus.zip",
      "https://github.com/stoltembergg-png/modus/releases/download/latest/Modus.zip",
      "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3-beta.1/Modus.zip",
      "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip?x=1",
      "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip#x",
      "https://user@github.com/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip",
      "https://github.com:8443/stoltembergg-png/modus/releases/download/v1.2.3/Modus.zip",
      "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3/..%2FModus.zip",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(isAllowedReleaseAssetUrl(bad), bad).toBe(false);
    }
  });

  it("allows only HTTPS redirects to GitHub's asset hosts", () => {
    expect(isAllowedDownloadRedirect("https://objects.githubusercontent.com/a?sig=1")).toBe(true);
    expect(isAllowedDownloadRedirect("https://release-assets.githubusercontent.com/a")).toBe(true);
    expect(isAllowedDownloadRedirect("http://objects.githubusercontent.com/a")).toBe(false);
    expect(isAllowedDownloadRedirect("https://evil.githubusercontent.com.evil.com/a")).toBe(false);
    expect(isAllowedDownloadRedirect("https://example.com/a")).toBe(false);
  });
});

describe("mac arch selection", () => {
  const base = "https://github.com/stoltembergg-png/modus/releases/download/v1.2.3";
  const arm = { url: `${base}/Modus-1.2.3-mac-arm64.zip`, sha512: "a", size: 1 };
  const x64 = { url: `${base}/Modus-1.2.3-mac-x64.zip`, sha512: "b", size: 1 };
  const armDmg = { url: `${base}/Modus-1.2.3-mac-arm64.dmg`, sha512: "c", size: 1 };

  it("detects arm64 Macs, including x64 builds under Rosetta", () => {
    expect(isArm64Mac({ arch: "arm64", runningUnderARM64Translation: false })).toBe(true);
    expect(isArm64Mac({ arch: "x64", runningUnderARM64Translation: true })).toBe(true);
    expect(isArm64Mac({ arch: "x64", runningUnderARM64Translation: false })).toBe(false);
  });

  it("prefers the arm64 zip on arm64 Macs and the non-arm64 zip on Intel", () => {
    expect(selectMacZip([armDmg, x64, arm], true)).toBe(arm);
    expect(selectMacZip([armDmg, arm, x64], false)).toBe(x64);
  });

  it("falls back to non-arm64 files when the release has no arm64 build", () => {
    expect(selectMacZip([x64], true)).toBe(x64);
    expect(selectMacZip([arm], false)).toBeUndefined();
    expect(selectMacZip([armDmg], true)).toBeUndefined();
  });
});

describe("macInstallBlocker", () => {
  const ok = {
    bundlePath: "/Applications/Modus.app",
    isInApplicationsFolder: true,
    parentWritable: true,
  };

  it("allows a writable bundle in /Applications", () => {
    expect(macInstallBlocker(ok)).toBeNull();
  });

  it("refuses to swap from a renamed bundle or the swap backup", () => {
    for (const bundlePath of [
      "/Applications/.Modus.app.update-backup",
      "/Applications/.Modus.app.update-backup/",
      "/Applications/Modus 2.app",
      "/Applications/modus.app",
      "/Applications/Modus.app.update-backup",
    ]) {
      expect(macInstallBlocker({ ...ok, bundlePath }), bundlePath).toBe("unexpected-bundle-path");
    }
    expect(macInstallBlocker({ ...ok, bundlePath: "/Applications/Modus.app/" })).toBeNull();
  });

  it("blocks translocated, mounted, non-Applications and read-only installs", () => {
    expect(
      macInstallBlocker({
        ...ok,
        bundlePath: "/private/var/folders/x/AppTranslocation/ABC/d/Modus.app",
      }),
    ).toBe("translocated");
    expect(macInstallBlocker({ ...ok, bundlePath: "/Volumes/Modus/Modus.app" })).toBe(
      "mounted-volume",
    );
    expect(macInstallBlocker({ ...ok, isInApplicationsFolder: false })).toBe("not-in-applications");
    expect(macInstallBlocker({ ...ok, parentWritable: false })).toBe("not-writable");
  });
});
