// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModusApi } from "../../../../preload/types";
import {
  DEFAULT_TOOL_FILTER_STATE,
  type ToolFilterApi,
  type ToolFilterModel,
  type ToolFilterState,
} from "../../../../shared/tool-filter";
import { ToolFilterSetting } from "./ToolFilterSetting";

function setupBridge(initialState: Partial<ToolFilterState> = {}) {
  let currentState: ToolFilterState = {
    ...DEFAULT_TOOL_FILTER_STATE,
    downloadBytes: 390_000_000,
    ...initialState,
  };
  const listeners = new Set<(state: ToolFilterState) => void>();

  const api: ToolFilterApi = {
    get: vi.fn(async () => currentState),
    enable: vi.fn(async () => {
      currentState = { ...currentState, enabled: true };
      for (const listener of listeners) listener(currentState);
      return currentState;
    }),
    disable: vi.fn(async () => {
      currentState = { ...currentState, enabled: false };
      for (const listener of listeners) listener(currentState);
      return currentState;
    }),
    cancelDownload: vi.fn(async () => {
      currentState = {
        ...currentState,
        enabled: false,
        download: { phase: "idle" },
      };
      for (const listener of listeners) listener(currentState);
      return currentState;
    }),
    onChange: vi.fn((handler: (state: ToolFilterState) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
  };

  Object.defineProperty(window, "modus", {
    configurable: true,
    value: { app: { toolFilter: api } } as unknown as ModusApi,
  });

  const push = (patch: Partial<ToolFilterState>) => {
    currentState = { ...currentState, ...patch };
    for (const listener of listeners) listener(currentState);
  };

  return { api, push, getState: () => currentState };
}

beforeEach(() => {
  document.documentElement.lang = "en";
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "modus", { configurable: true, value: undefined });
  document.documentElement.lang = "en";
});

describe("ToolFilterSetting", () => {
  it("default state (no stored choice) renders on, with no prompt and no enable call", async () => {
    const { api } = setupBridge();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("heading", { name: "Turn on local tool filter" })).toBeNull();
    expect(api.enable).not.toHaveBeenCalled();
  });

  it("turning the default off calls disable directly", async () => {
    const { api } = setupBridge();
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    await user.click(toggle);

    expect(api.disable).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders off state correctly", async () => {
    setupBridge({ enabled: false });
    render(<ToolFilterSetting />);

    expect(await screen.findByRole("heading", { name: "Local tool filter" })).toBeTruthy();
    expect(
      screen.getByText("Sends only the tools a request likely needs, computed on this device."),
    ).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: "Local tool filter" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(false);
  });

  it("toggling on opens the prompt with the size and does not call enable", async () => {
    const { api } = setupBridge({ enabled: false, downloadBytes: 390_000_000 });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    await user.click(toggle);

    expect(await screen.findByRole("heading", { name: "Turn on local tool filter" })).toBeTruthy();
    expect(screen.getByText(/390 MB/)).toBeTruthy();
    expect(api.enable).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("confirm in prompt calls enable", async () => {
    const { api } = setupBridge({ enabled: false, downloadBytes: 390_000_000 });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    await user.click(toggle);

    const confirmBtn = await screen.findByRole("button", { name: "Download and turn on" });
    await user.click(confirmBtn);

    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it("cancel in the prompt keeps it off", async () => {
    const { api } = setupBridge({ enabled: false, downloadBytes: 390_000_000 });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    await user.click(toggle);

    const cancelBtn = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);

    expect(api.enable).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Turn on local tool filter" })).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("partialBytes shows the resume line in prompt", async () => {
    setupBridge({
      enabled: false,
      downloadBytes: 390_000_000,
      partialBytes: 120_000_000,
    });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    await user.click(toggle);

    expect(await screen.findByText("120 MB already downloaded; it will resume.")).toBeTruthy();
  });

  it("downloading shows a progressbar and Cancel download calls cancelDownload", async () => {
    const { api } = setupBridge({
      enabled: true,
      download: { phase: "downloading", receivedBytes: 45_000_000, totalBytes: 390_000_000 },
    });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const progressbar = await screen.findByRole("progressbar");
    expect(progressbar.getAttribute("aria-valuenow")).toBe("12");
    expect(screen.getByText("45 of 390 MB (12%)")).toBeTruthy();

    const cancelDownloadBtn = screen.getByRole("button", { name: "Cancel download" });
    await user.click(cancelDownloadBtn);

    expect(api.cancelDownload).toHaveBeenCalledTimes(1);
  });

  it("verifying phase shows progressbar and verifying text", async () => {
    setupBridge({
      enabled: true,
      download: { phase: "verifying", totalBytes: 390_000_000 },
    });
    render(<ToolFilterSetting />);

    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.getByText("Verifying files…")).toBeTruthy();
  });

  it("failed hash-mismatch line renders without retry button", async () => {
    setupBridge({
      enabled: true,
      download: { phase: "failed", error: "hash-mismatch", message: "mismatch" },
    });
    render(<ToolFilterSetting />);

    expect(
      await screen.findByText("The downloaded files did not pass verification and were removed."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
  });

  it("failed download-failed renders error line and Retry now calls enable", async () => {
    const { api } = setupBridge({
      enabled: true,
      download: { phase: "failed", error: "download-failed", message: "network error" },
    });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    expect(
      await screen.findByText(
        "Download failed. It will retry automatically; check your connection.",
      ),
    ).toBeTruthy();

    const retryBtn = screen.getByRole("button", { name: "Retry now" });
    await user.click(retryBtn);

    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it("unavailable intel-mac → switch disabled + reason line", async () => {
    setupBridge({
      availability: { available: false, reason: "intel-mac" },
    });
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText(
        "Not available on Intel Macs: the on-device model runtime has no Intel build.",
      ),
    ).toBeTruthy();
  });

  it("unavailable vc-runtime-missing → switch disabled + reason line", async () => {
    setupBridge({
      availability: { available: false, reason: "vc-runtime-missing" },
    });
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText(
        "Needs the Microsoft Visual C++ Redistributable (2015–2022). Install it, then restart Modus.",
      ),
    ).toBeTruthy();
  });

  it("shows each model status when ready", async () => {
    const modelStatuses: Record<ToolFilterModel, string> = {
      starting: "Starting the on-device model…",
      ready: "On. Requests send only the relevant tools.",
      failed: "The on-device model stopped; requests send all tools until it restarts.",
      stopped: "On. The model starts with the next request.",
    };

    for (const [model, expectedText] of Object.entries(modelStatuses) as [
      ToolFilterModel,
      string,
    ][]) {
      setupBridge({
        enabled: true,
        download: { phase: "ready" },
        model,
      });
      const { unmount } = render(<ToolFilterSetting />);
      expect(await screen.findByText(expectedText)).toBeTruthy();
      unmount();
      cleanup();
    }
  });

  it("turning off calls disable directly without prompt", async () => {
    const { api } = setupBridge({
      enabled: true,
      download: { phase: "ready" },
      model: "ready",
    });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);

    expect(api.disable).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Turn on local tool filter" })).toBeNull();
  });

  it("updates live via onChange subscription", async () => {
    const { push } = setupBridge({ enabled: false });
    render(<ToolFilterSetting />);

    const toggle = await screen.findByRole("switch", { name: "Local tool filter" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      push({ enabled: true, download: { phase: "ready" }, model: "ready" });
    });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("On. Requests send only the relevant tools.")).toBeTruthy();
  });

  it("renders Portuguese strings when document language is pt-BR", async () => {
    document.documentElement.lang = "pt-BR";
    setupBridge({
      enabled: false,
      downloadBytes: 390_000_000,
      partialBytes: 120_000_000,
    });
    const user = userEvent.setup();
    render(<ToolFilterSetting />);

    expect(
      await screen.findByRole("heading", { name: "Filtro local de ferramentas" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Envia só as ferramentas de que cada solicitação provavelmente precisa, escolhidas neste dispositivo.",
      ),
    ).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: "Filtro local de ferramentas" });
    await user.click(toggle);

    expect(
      await screen.findByRole("heading", { name: "Ativar filtro local de ferramentas" }),
    ).toBeTruthy();
    expect(screen.getByText("Baixar e ativar")).toBeTruthy();
    expect(screen.getByText("Cancelar")).toBeTruthy();
    expect(
      screen.getByText("120 MB já baixados; o download continuará de onde parou."),
    ).toBeTruthy();
  });
});
