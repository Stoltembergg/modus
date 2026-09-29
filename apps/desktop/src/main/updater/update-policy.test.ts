import { describe, expect, it } from "vitest";
import { RELEASE_REPO } from "../../shared/release-repo";
import {
  appliesOnQuitFor,
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

const REPO = `${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`;

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

describe("appliesOnQuitFor", () => {
  it("is false on Windows: the silent NSIS installer gives up if it cannot close the app", () => {
    expect(appliesOnQuitFor("win32")).toBe(false);
  });

  it("is true on macOS: the swap script keeps waiting for the app to exit", () => {
    expect(appliesOnQuitFor("darwin")).toBe(true);
  });

  it("is true on Linux: in-place installs are AppImage, already replaced at install", () => {
    expect(appliesOnQuitFor("linux")).toBe(true);
    // deb never installs in place, so the flag is never asked for there.
    expect(resolveUpdatePolicy({ ...packaged, platform: "linux", env: {} })).toMatchObject({
      installMode: "download-page",
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
    expect(releasePageUrl("1.2.3")).toBe(`https://github.com/${REPO}/releases/tag/v1.2.3`);
    expect(releasePageUrl()).toBe(`https://github.com/${REPO}/releases/latest`);
    expect(releaseAssetUrl("1.2.3", "Modus-1.2.3-mac-arm64.zip")).toBe(
      `https://github.com/${REPO}/releases/download/v1.2.3/Modus-1.2.3-mac-arm64.zip`,
    );
    expect(() => releaseAssetUrl("1.2.3", "../evil.zip")).toThrow();
    expect(() => releaseAssetUrl("1.2.3", "a/b.zip")).toThrow();
    expect(() => releaseAssetUrl("1.2.3", ".hidden")).toThrow();
    expect(() => releaseAssetUrl("1.2.3-beta.1", "x.zip")).toThrow();
  });

  it("allowlists only official release download URLs", () => {
    const ok = `https://github.com/${REPO}/releases/download/v1.2.3/Modus.zip`;
    expect(isAllowedReleaseAssetUrl(ok)).toBe(true);
    expect(isAllowedReleaseAssetUrl(ok, "1.2.3")).toBe(true);
    expect(isAllowedReleaseAssetUrl(ok, "1.2.4")).toBe(false);
    for (const bad of [
      `http://github.com/${REPO}/releases/download/v1.2.3/Modus.zip`,
      `https://evil.com/${REPO}/releases/download/v1.2.3/Modus.zip`,
      `https://github.com.evil.com/${REPO}/releases/download/v1.2.3/Modus.zip`,
      "https://github.com/brandlll-lee/modus/releases/download/v1.2.3/Modus.zip",
      `https://github.com/${REPO}-evil/releases/download/v1.2.3/Modus.zip`,
      `https://github.com/${REPO}/releases/download/v1.2.3/x/Modus.zip`,
      `https://github.com/${REPO}/releases/download/latest/Modus.zip`,
      `https://github.com/${REPO}/releases/download/v1.2.3-beta.1/Modus.zip`,
      `https://github.com/${REPO}/releases/download/v1.2.3/Modus.zip?x=1`,
      `https://github.com/${REPO}/releases/download/v1.2.3/Modus.zip#x`,
      `https://user@github.com/${REPO}/releases/download/v1.2.3/Modus.zip`,
      `https://github.com:8443/${REPO}/releases/download/v1.2.3/Modus.zip`,
      `https://github.com/${REPO}/releases/download/v1.2.3/..%2FModus.zip`,
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(isAllowedReleaseAssetUrl(bad), bad).toBe(false);
    }
  });

  it("accepts the renamed owner and rejects the old one (it can be registered by anyone)", () => {
    const path = "/releases/download/v1.2.3/Modus-1.2.3-mac-arm64.zip";
    expect(isAllowedReleaseAssetUrl(`https://github.com/Stoltembergg/modus${path}`)).toBe(true);
    expect(isAllowedReleaseAssetUrl(`https://github.com/stoltembergg-png/modus${path}`)).toBe(
      false,
    );
    expect(isAllowedReleaseAssetUrl(`https://github.com/Stoltembergg-png/modus${path}`)).toBe(
      false,
    );
  });

  it("ignores case only in the owner and repository segments", () => {
    const path = "/releases/download/v1.2.3/Modus-1.2.3-mac-arm64.zip";
    for (const repo of ["Stoltembergg/modus", "stoltembergg/modus", "STOLTEMBERGG/MODUS"]) {
      expect(isAllowedReleaseAssetUrl(`https://github.com/${repo}${path}`), repo).toBe(true);
      expect(isAllowedReleaseAssetUrl(`https://github.com/${repo}${path}`, "1.2.3"), repo).toBe(
        true,
      );
    }
    for (const bad of [
      // The tag is exact: "V1.2.3" is not "v1.2.3". (The file name is never case-folded
      // either; only its shape is checked, and size + sha512 from latest*.yml pin it.)
      `https://github.com/${REPO}/releases/download/V1.2.3/Modus-1.2.3-mac-arm64.zip`,
      // So are the fixed path segments.
      `https://github.com/${REPO}/Releases/download/v1.2.3/Modus.zip`,
      `https://github.com/${REPO}/releases/Download/v1.2.3/Modus.zip`,
      // Old owner, in any casing.
      "https://github.com/STOLTEMBERGG-PNG/modus/releases/download/v1.2.3/Modus.zip",
      // Case-insensitive, not prefix/suffix matching.
      "https://github.com/Stoltembergg/modu/releases/download/v1.2.3/Modus.zip",
      "https://github.com/xStoltembergg/modus/releases/download/v1.2.3/Modus.zip",
      "https://github.com/Stoltembergg/modus/releases/download/v1.2.3/",
      "https://github.com/Stoltembergg/modus//releases/download/v1.2.3/Modus.zip",
    ]) {
      expect(isAllowedReleaseAssetUrl(bad), bad).toBe(false);
    }
    // The version check stays exact too.
    expect(
      isAllowedReleaseAssetUrl(
        `https://github.com/stoltembergg/modus/releases/download/v1.2.3/Modus.zip`,
        "1.2.4",
      ),
    ).toBe(false);
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
  const base = `https://github.com/${REPO}/releases/download/v1.2.3`;
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
