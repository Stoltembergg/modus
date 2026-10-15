import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D2 transparency modes, measured with real computed styles: app.css is built
 * the way `electron-vite build` does (Tailwind compile + Lightning CSS
 * optimize) and loaded into headless Chrome over CDP. CI (ubuntu-latest) ships
 * Google Chrome; without a browser the suite fails on CI and skips locally.
 *
 * "Effective alpha" = the element composited over every ancestor up to <html>,
 * i.e. how much of the window material (vibrancy / Mica) can show through it.
 */
const CHROME = [process.env.CHROME_PATH, "google-chrome", "google-chrome-stable", "chromium"]
  .filter((bin): bin is string => Boolean(bin))
  .find((bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0);
if (!CHROME && process.env.CI) throw new Error("D2 computed-style test needs Chrome on CI");

const SCENE = `
<div id="root"><div class="app-shell"><div class="app-layout-row surface-app">
  <nav class="app-rail"><button class="app-rail-item" type="button">A</button></nav>
  <aside class="app-context-sidebar bg-panel"><div class="app-context-sidebar-body bg-panel"></div></aside>
  <main class="surface-main rounded-b-lg border border-hairline-strong border-t-0" style="width:600px">
    <div class="surface-raised"></div>
    <div class="popup-chrome"></div>
    <div class="pdf-page-chrome"></div>
    <div class="dialog-scrim"></div>
    <div class="composer-glass"></div>
    <div class="message-card-slot message-role-row flex min-w-0 items-start justify-end gap-2 ml-auto" data-message-row="user"><div class="chat-message-bubble chat-message-surface" data-message-role="user" data-message-card>Oi</div><span class="size-[24px] shrink-0" data-user-avatar></span></div>
    <div class="message-role-row flex min-w-0 items-start gap-2" data-message-row="assistant"><span class="size-[24px] shrink-0" data-assistant-avatar></span><div class="chat-message-bubble chat-message-surface" data-message-role="assistant" data-assistant-card>Reply</div></div>
    <div class="message-role-row flex min-w-0 items-start gap-2" data-message-row="assistant"><span class="size-[24px] shrink-0" data-technical-avatar></span><div class="chat-message-bubble chat-message-surface" data-message-role="assistant" data-technical-card><pre><code>+kept line</code></pre><table><tr><td>a very wide table</td></tr></table></div></div>
    <div class="chat-message-bubble chat-message-surface" data-table-menu-card><div class="modus-markdown"><div data-streamdown="table-wrapper"><div><button type="button">Copy table</button></div><div data-table-frame><table style="width:1200px"><thead><tr>${Array.from({ length: 12 }, (_, i) => `<th>Column ${i}</th>`).join("")}</tr></thead><tbody><tr>${Array.from({ length: 12 }, (_, i) => `<td>Wide table cell ${i}</td>`).join("")}</tr></tbody></table></div><div class="top-full" data-table-menu><button type="button">Markdown</button><button type="button">CSV</button><button type="button">TSV</button></div></div></div></div>
    <div class="chat-message-surface bg-card"></div>
    <div class="chat-run-status"></div>
    <section class="settings-content">
      <div class="bg-panel" data-settings-list></div>
      <input class="bg-canvas" data-settings-input />
      <textarea class="bg-panel" data-settings-editor></textarea>
    </section>
  </main>
</div></div></div>`;
const CANDIDATES = [
  "flex",
  "w-full",
  "w-1/2",
  "min-w-0",
  "items-start",
  "justify-end",
  "ml-auto",
  "gap-2",
  "size-[24px]",
  "shrink-0",
  "bg-panel",
  "rounded-b-lg",
  "border",
  "border-hairline-strong",
  "border-t-0",
  "bg-canvas",
  "bg-card",
];
const PANELS = [".app-rail", ".app-context-sidebar", ".surface-main"];
const CHROME_PARTS = [".app-rail", ".app-context-sidebar"];
const OVERLAYS = [".surface-raised", ".popup-chrome", ".pdf-page-chrome"];
const CHAT_AVATARS = ["[data-user-avatar]", "[data-assistant-avatar]", "[data-technical-avatar]"];
const CHAT_SURFACES = [
  ".composer-glass",
  "[data-message-card]",
  "[data-assistant-card]",
  "[data-technical-card]",
  ".chat-message-surface",
  "[data-settings-list]",
  "[data-settings-input]",
  "[data-settings-editor]",
];
const THEMES = ["dark", "dark-plus", "light"] as const;
const OS = ["reduced-transparency", "more-contrast", "forced-colors"] as const;
type Os = (typeof OS)[number] | undefined;

type Probe = {
  alpha: number;
  effective: number;
  backdrop: string;
  width: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  innerWidth: number;
  innerLeft: number;
  innerRight: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  overflowX: string;
  scrollWidth: number;
  clientWidth: number;
};
type Edge = { alpha: number; width: number };
type Measured = Record<string, Probe> & {
  edges: { railDivider: Edge; mainLeft: Edge; mainRight: Edge; mainBottom: Edge };
  focus: { style: string; width: number; alpha: number };
};

/** Runs in the page: computed backgrounds, panel-edge borders and the focus ring. */
const MEASURE = `(${(selectors: string[]) => {
  const alphaOf = (color: string): number => {
    const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (slash?.[1])
      return slash[1].endsWith("%") ? Number.parseFloat(slash[1]) / 100 : Number(slash[1]);
    const rgba = color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/);
    if (rgba?.[1]) return Number(rgba[1]);
    return color === "transparent" ? 0 : 1;
  };
  const out: Record<string, unknown> = {};
  for (const selector of selectors) {
    const element = document.querySelector(selector) as Element;
    let through = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      through *= 1 - alphaOf(getComputedStyle(node).backgroundColor);
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const insetLeft = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const insetRight = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
    out[selector] = {
      width: rect.width,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      innerWidth: rect.width - insetLeft - insetRight,
      innerLeft: rect.left + insetLeft,
      innerRight: rect.right - insetRight,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
      overflowX: style.overflowX,
      scrollWidth: (element as HTMLElement).scrollWidth,
      clientWidth: (element as HTMLElement).clientWidth,
      alpha: alphaOf(style.backgroundColor),
      effective: 1 - through,
      // Chrome aliases -webkit-backdrop-filter to this; glassTokens (e) checks
      // the build emits both declarations.
      backdrop: style.getPropertyValue("backdrop-filter"),
    };
  }
  const edge = (style: CSSStyleDeclaration, side: string) => ({
    alpha: alphaOf(style.getPropertyValue(`border-${side}-color`)),
    width: Number.parseFloat(style.getPropertyValue(`border-${side}-width`)),
  });
  const main = getComputedStyle(document.querySelector(".surface-main") as Element);
  out.edges = {
    railDivider: edge(
      getComputedStyle(document.querySelector(".app-rail") as Element, "::after"),
      "right",
    ),
    mainLeft: edge(main, "left"),
    mainRight: edge(main, "right"),
    mainBottom: edge(main, "bottom"),
  };
  const button = document.querySelector(".app-rail-item") as HTMLElement;
  button.focus({ focusVisible: true } as FocusOptions);
  const ring = getComputedStyle(button);
  out.focus = {
    style: ring.outlineStyle,
    width: Number.parseFloat(ring.outlineWidth),
    alpha: alphaOf(ring.outlineColor),
  };
  button.blur();
  return JSON.stringify(out);
}})`;

describe.skipIf(!CHROME)("D2 transparency modes in real computed styles (headless Chrome)", () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-d2-glass-"));
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let nextId = 0;
  type Response = { result?: { errorText?: string; result?: { value?: string } } };
  const pending = new Map<number, (value: Response) => void>();
  const send = (method: string, params: object = {}) =>
    new Promise<Response>((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      socket?.send(JSON.stringify({ id: nextId, method, params }));
    });

  async function measure(
    theme: string,
    glass: boolean,
    transparency: "full" | "sidebar" | "off",
    os?: Os,
    mainWidth = 600,
  ): Promise<Measured> {
    await send("Emulation.setDeviceMetricsOverride", {
      width: mainWidth === 360 ? 360 : 800,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Pin every accessibility feature (the host's own settings must not leak in).
    await send("Emulation.setEmulatedMedia", {
      features: [
        {
          name: "prefers-reduced-transparency",
          value: os === "reduced-transparency" ? "reduce" : "no-preference",
        },
        { name: "prefers-contrast", value: os === "more-contrast" ? "more" : "no-preference" },
        { name: "forced-colors", value: os === "forced-colors" ? "active" : "none" },
      ],
    });
    const root = `Object.assign(document.documentElement.dataset, ${JSON.stringify({
      theme,
      nativeGlass: String(glass),
      transparency,
    })}); document.querySelector('.surface-main').style.width = '${mainWidth}px';`;
    const response = await send("Runtime.evaluate", {
      expression: `(async () => {
        ${root}
        // Measure the settled palette, including the Composer's existing transition.
        getComputedStyle(document.querySelector('.composer-glass')).backgroundColor;
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
        return ${MEASURE}(${JSON.stringify([...PANELS, ...OVERLAYS, ...CHAT_SURFACES, ...CHAT_AVATARS, "[data-table-menu-card]", '[data-streamdown="table-wrapper"]', "[data-table-frame]", "[data-table-menu]", ".chat-run-status", ".app-shell", "html"])});
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return JSON.parse(response.result?.result?.value ?? "{}") as Measured;
  }

  /** The panel-edge dividers and the focus ring as they are without glass. */
  function expectTodaysEdges(m: Measured, at: string): void {
    for (const [name, edge] of Object.entries(m.edges)) {
      expect(edge.alpha, `${at} ${name} colour`).toBeGreaterThan(0);
      expect(edge.width, `${at} ${name} width`).toBeGreaterThan(0);
    }
  }
  function expectFocusRing(m: Measured, at: string): void {
    expect(m.focus.style, `${at} focus ring`).not.toBe("none");
    expect(m.focus.width, `${at} focus ring width`).toBeGreaterThan(0);
    expect(m.focus.alpha, `${at} focus ring colour`).toBeGreaterThan(0);
  }

  beforeAll(async () => {
    const cssPath = fileURLToPath(new URL("./app.css", import.meta.url));
    const compiler = await compile(readFileSync(cssPath, "utf8"), {
      base: dirname(cssPath),
      onDependency: () => undefined,
    });
    const css = optimize(compiler.build(CANDIDATES), { minify: true }).code;
    const page = join(dir, "index.html");
    writeFileSync(
      page,
      `<!doctype html><html><head><style>${css}</style></head><body>${SCENE}</body></html>`,
    );

    browser = spawn(
      CHROME as string,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${join(dir, "profile")}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const endpoint = await new Promise<string>((resolve, reject) => {
      let log = "";
      browser?.stderr?.on("data", (chunk: Buffer) => {
        log += chunk.toString();
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match?.[1]) resolve(match[1]);
      });
      browser?.once("exit", () => reject(new Error(`Chrome exited: ${log}`)));
    });
    const version = await (
      await fetch(endpoint.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "/json/list"))
    ).json();
    const target = (version as { type: string; webSocketDebuggerUrl: string }[]).find(
      (t) => t.type === "page",
    );
    socket = new WebSocket(target?.webSocketDebuggerUrl ?? "");
    await new Promise((resolve) => socket?.addEventListener("open", resolve));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    await send("Page.enable");
    // Headless pages are never focused; focus-visible needs a focused page.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const url = pathToFileURL(page).href;
    const navigation = await send("Page.navigate", { url });
    if (navigation.result?.errorText) {
      throw new Error(`Glass fixture navigation failed: ${navigation.result.errorText}`);
    }
    let loaded = false;
    for (let tries = 0; tries < 100; tries += 1) {
      const ready = await send("Runtime.evaluate", {
        expression: `JSON.stringify(location.href === ${JSON.stringify(url)} && document.readyState === "complete" && document.querySelector('.surface-main') !== null)`,
        returnByValue: true,
      });
      if (ready.result?.result?.value === "true") {
        loaded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!loaded) throw new Error("Glass fixture did not finish loading before measurement");
  }, 30_000);

  afterAll(async () => {
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser?.once("exit", resolve));
      // Browser.close shuts every Chrome child down before the main process exits.
      void send("Browser.close");
      const timer = setTimeout(() => browser?.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    }
    socket?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A late Chrome helper may still hold the temp profile; the OS cleans tmp.
    }
  }, 15_000);

  it("Sidebar: one window tint behind rail + sidebar; main opaque without the sidebar|main line", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "sidebar");
      // Regression: <html> used to paint the canvas over the whole window material.
      expect(m.html?.alpha, `${theme} html`).toBe(0);
      expect(m[".app-shell"]?.alpha, `${theme} window tint`).toBeCloseTo(0.78, 2);
      expect(m[".app-shell"]?.backdrop, `${theme} window blur`).toMatch(/blur\(/);
      for (const part of CHROME_PARTS) {
        expect(m[part]?.alpha, `${theme} ${part} own background`).toBe(0);
        expect(m[part]?.effective, `${theme} ${part}`).toBeCloseTo(0.78, 2);
        expect(m[part]?.backdrop, `${theme} ${part} blur`).toBe("none");
      }
      expect(m[".surface-main"]?.effective, `${theme} main`).toBe(1);
      expect(m[".surface-main"]?.backdrop, `${theme} main blur`).toBe("none");
      for (const part of [...OVERLAYS, ...CHAT_SURFACES]) {
        expect(m[part]?.effective, `${theme} ${part}`).toBe(1);
        expect(m[part]?.backdrop, `${theme} ${part}`).toBe("none");
      }
      expect(m.edges.railDivider.alpha, `${theme} rail|sidebar divider`).toBe(0);
      expect(m.edges.mainLeft.alpha, `${theme} sidebar|main line`).toBe(0);
      // Main keeps its other edges in Sidebar mode.
      expect(m.edges.mainRight.alpha, `${theme} main right edge`).toBeGreaterThan(0);
      expectFocusRing(m, `${theme} sidebar`);
    }
  });

  it("Full: rail, sidebar and main share one alpha on one blurred layer; no dividers", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "full");
      expect(m[".app-shell"]?.backdrop, `${theme} window blur`).toMatch(/blur\(/);
      const effective = PANELS.map((part) => m[part]?.effective);
      expect(new Set(effective).size, `${theme} equal alpha ${effective}`).toBe(1);
      expect(effective[0], `${theme} shared alpha`).toBeCloseTo(0.78, 2);
      for (const part of PANELS) {
        expect(m[part]?.alpha, `${theme} ${part} own background`).toBe(0);
        expect(m[part]?.backdrop, `${theme} ${part} blur`).toBe("none");
      }
      for (const part of OVERLAYS) {
        expect(m[part]?.effective, `${theme} ${part}`).toBeLessThan(1);
        expect(m[part]?.backdrop, `${theme} ${part}`).toMatch(/blur\(/);
      }
      for (const [name, edge] of Object.entries(m.edges)) {
        expect(edge.alpha, `${theme} ${name} divider`).toBe(0);
      }
      expectFocusRing(m, `${theme} full`);
    }
  });

  it("Full: chat surfaces are only slightly denser than the app; Thinking adds no layer", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "full");
      for (const part of CHAT_SURFACES) {
        expect(m[part]?.alpha, `${theme} ${part} tint`).toBeCloseTo(0.1, 2);
        expect(m[part]?.effective, `${theme} ${part} composite`).toBeCloseTo(0.802, 3);
      }
      expect(m[".chat-run-status"]?.alpha).toBe(0);
      expect(m[".chat-run-status"]?.effective).toBe(m[".surface-main"]?.effective);
      expect(m[".chat-run-status"]?.backdrop).toBe("none");
    }
  });

  it("keeps each complete message row within its role lane at desktop and narrow widths", async () => {
    for (const theme of THEMES) {
      for (const width of [600, 360]) {
        const m = await measure(theme, true, "full", undefined, width);
        const main = m[".surface-main"] as Probe;
        const split = main.innerLeft + main.innerWidth / 2;
        const user = m["[data-message-card]"] as Probe;
        const assistant = m["[data-assistant-card]"] as Probe;
        const technical = m["[data-technical-card]"] as Probe;
        const assistantAvatar = m["[data-assistant-avatar]"] as Probe;
        const userAvatar = m["[data-user-avatar]"] as Probe;
        expect(assistantAvatar.left).toBeCloseTo(main.innerLeft, 0);
        expect(assistant.right).toBeLessThanOrEqual(split);
        expect(technical.right).toBeLessThanOrEqual(split);
        expect(user.left).toBeGreaterThanOrEqual(split);
        expect(userAvatar.right).toBeCloseTo(main.innerRight, 0);
        expect(user.left - assistant.right).toBeGreaterThanOrEqual(8);
        expect(assistant.paddingTop).toBe(8);
        expect(assistant.paddingBottom).toBe(8);
        expect(assistant.paddingLeft).toBe(16);
        expect(assistant.paddingRight).toBe(16);
        for (const selector of CHAT_AVATARS) expect(m[selector]?.width).toBe(24);
      }
    }
  });

  it("keeps the open table copy menu visible while the genuinely wide inner table scrolls", async () => {
    const m = await measure("dark", true, "full");
    const wrapper = m['[data-streamdown="table-wrapper"]'] as Probe;
    const frame = m["[data-table-frame]"] as Probe;
    const menu = m["[data-table-menu]"] as Probe;
    expect(wrapper.overflowX).toBe("visible");
    expect(frame.overflowX).toBe("auto");
    expect(frame.scrollWidth).toBeGreaterThan(frame.clientWidth);
    expect(menu.width).toBeGreaterThan(0);
    expect(menu.top).toBeGreaterThanOrEqual(frame.bottom);
    expect(menu.bottom).toBeLessThan(900);
    expect(menu.left).toBeGreaterThanOrEqual(wrapper.left);
    expect(menu.right).toBeLessThanOrEqual(wrapper.right);
  });

  it("Off (also what main resolves OS accessibility to): opaque, today's dividers, no CSS blur", async () => {
    for (const theme of THEMES) {
      for (const transparency of ["off", "full", "sidebar"] as const) {
        // data-native-glass="false" is what main sends for Off and for any OS block.
        const m = await measure(theme, false, transparency);
        for (const part of [...PANELS, ...OVERLAYS, ...CHAT_SURFACES]) {
          expect(m[part]?.effective, `${theme} ${transparency} ${part}`).toBe(1);
          expect(m[part]?.backdrop, `${theme} ${transparency} ${part}`).toBe("none");
        }
        expect(m[".app-shell"]?.backdrop).toBe("none");
        expectTodaysEdges(m, `${theme} ${transparency}`);
        expectFocusRing(m, `${theme} ${transparency}`);
      }
    }
  });

  it("CSS second line of defence: reduce transparency / more contrast / forced colors keep today's solid look", async () => {
    for (const theme of THEMES) {
      for (const transparency of ["full", "sidebar"] as const) {
        for (const os of OS) {
          const m = await measure(theme, true, transparency, os);
          const at = `${theme} ${transparency} ${os}`;
          for (const part of [...PANELS, ...OVERLAYS, ...CHAT_SURFACES]) {
            expect(m[part]?.effective, `${at} ${part}`).toBe(1);
            expect(m[part]?.backdrop, `${at} ${part}`).toBe("none");
          }
          expect(m[".app-shell"]?.backdrop, `${at} window blur`).toBe("none");
          expectTodaysEdges(m, at);
          expectFocusRing(m, at);
        }
      }
    }
  });
});
