import type { GroupFinalResultCard as GroupFinalResultCardModel } from "../../../../shared/group-result-card";
import { useGroupText } from "./groupRoomI18n";

function ResultSection({
  title,
  items,
  testId,
}: {
  title: string;
  items: readonly string[];
  testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="font-medium text-2xs text-fg-faint tracking-wide">{title}</div>
      {items.length === 1 ? (
        <p className="mt-0.5 whitespace-pre-wrap text-fg text-sm leading-relaxed">{items[0]}</p>
      ) : (
        <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-fg text-sm leading-relaxed">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Clear Coordinator consolidation card: outcome, validations, changed files,
 * open items. Renders inside the Lead's message — not a nested marketing card.
 */
export function GroupFinalResultCard({ card }: { card: GroupFinalResultCardModel }) {
  const t = useGroupText();
  return (
    <div
      className="mt-1 space-y-2.5 border-hairline border-l-2 pl-3"
      data-testid="group-final-result-card"
    >
      <div data-testid="group-final-result-outcome">
        <div className="font-medium text-2xs text-fg-faint tracking-wide">
          {t("result.outcome")}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-fg text-sm leading-relaxed">{card.outcome}</p>
      </div>
      <ResultSection
        items={card.validations}
        testId="group-final-result-validations"
        title={t("result.validations")}
      />
      <ResultSection
        items={card.changedFiles}
        testId="group-final-result-changed-files"
        title={t("result.changedFiles")}
      />
      <ResultSection
        items={card.openItems}
        testId="group-final-result-open-items"
        title={t("result.openItems")}
      />
    </div>
  );
}
