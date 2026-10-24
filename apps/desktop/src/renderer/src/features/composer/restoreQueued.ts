import type { AbortAgentResult } from "../../../../shared/contracts";
import type { ComposerDraft } from "./Composer";
import type { ComposerImage } from "./useComposerImages";

/**
 * Put prompts that Stop took back from the queue into the composer, in order:
 * queued text goes before anything already typed (blank line between), queued
 * images go before images already attached.
 */
export function restoreQueuedToDraft<D extends ComposerDraft>(
  draft: D,
  restored: AbortAgentResult["restored"],
): D {
  if (restored.length === 0) return draft;
  const queuedText = restored
    .map((item) => item.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const value = [queuedText, draft.value].filter((text) => text.trim().length > 0).join("\n\n");
  const images: ComposerImage[] = restored.flatMap((item, itemIndex) =>
    item.attachments.map((image, index) => ({
      id: `restored-${Date.now()}-${itemIndex}-${index}`,
      name: image.name ?? `image-${index + 1}`,
      mimeType: image.mimeType,
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
    })),
  );
  let parts = draft.parts;
  if (parts?.length && queuedText) {
    const [first, ...rest] = parts;
    parts =
      first?.type === "text"
        ? [{ type: "text", text: [queuedText, first.text].filter(Boolean).join("\n\n") }, ...rest]
        : [{ type: "text", text: `${queuedText}\n\n` }, ...parts];
  }
  return { ...draft, value, images: [...images, ...draft.images], parts };
}
