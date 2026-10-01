import { IntegrationsSettingsPanel } from "./sections/integrations";

export function ConnectionsPage() {
  return (
    <section
      className="surface-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="connections-page"
      data-shell-layer="connections-page"
    >
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-8 px-10 pt-16 pb-12">
          <IntegrationsSettingsPanel standalone />
        </div>
      </div>
    </section>
  );
}
