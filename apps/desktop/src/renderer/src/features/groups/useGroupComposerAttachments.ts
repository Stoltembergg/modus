import { useCallback, useState } from "react";
import type { GroupMessageContextItem, PromptImageAttachment } from "../../../../shared/contracts";
import { formatAttachmentSize } from "../../../../shared/group-prompt-kit";
import { groupText } from "../../../../shared/group-room-locale";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_GROUP_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type GroupComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: "ready" | "error";
  error?: string;
  kind: "image" | "file";
  /** Full data URL for image preview + send. */
  dataUrl?: string;
  /** Absolute path for Electron file context (non-image). */
  path?: string;
};

export type GroupComposerAttachmentUpdate =
  | GroupComposerAttachment[]
  | ((current: GroupComposerAttachment[]) => GroupComposerAttachment[]);

type ElectronFile = File & { path?: string };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(groupText("attachments.readFailed")));
    reader.readAsDataURL(file);
  });
}

function dataUrlPayload(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Multi-file attachment state for the group composer (Prompt Kit File Upload).
 * Images → PromptImageAttachment; path-backed files → ContextItem.
 * Per-file errors do not block other valid attachments.
 */
export function useGroupComposerAttachments(options?: {
  attachments?: GroupComposerAttachment[];
  onChange?: (update: GroupComposerAttachmentUpdate) => void;
  /** Room locale for the per-file errors (default: the renderer locale). */
  locale?: string | null | undefined;
}) {
  const locale = options?.locale;
  const [uncontrolled, setUncontrolled] = useState<GroupComposerAttachment[]>([]);
  const attachments = options?.attachments ?? uncontrolled;
  const setAttachments = options?.onChange ?? setUncontrolled;

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const next: GroupComposerAttachment[] = [];
      for (const file of files) {
        const id = crypto.randomUUID();
        const name = file.name || "file";
        const mimeType = file.type || "application/octet-stream";
        const size = file.size;
        if (IMAGE_MIME.has(mimeType)) {
          if (size > MAX_IMAGE_BYTES) {
            next.push({
              id,
              name,
              mimeType,
              size,
              status: "error",
              error: groupText("attachments.imageTooLarge", locale, {
                max: MAX_IMAGE_BYTES / 1024 / 1024,
              }),
              kind: "image",
            });
            continue;
          }
          try {
            const dataUrl = await readAsDataUrl(file);
            next.push({
              id,
              name,
              mimeType,
              size,
              status: "ready",
              kind: "image",
              dataUrl,
            });
          } catch {
            next.push({
              id,
              name,
              mimeType,
              size,
              status: "error",
              error: groupText("attachments.imageUnreadable", locale),
              kind: "image",
            });
          }
          continue;
        }
        if (size > MAX_FILE_BYTES) {
          next.push({
            id,
            name,
            mimeType,
            size,
            status: "error",
            error: groupText("attachments.fileTooLarge", locale, {
              max: MAX_FILE_BYTES / 1024 / 1024,
            }),
            kind: "file",
          });
          continue;
        }
        const path = (file as ElectronFile).path?.trim();
        if (!path) {
          next.push({
            id,
            name,
            mimeType,
            size,
            status: "error",
            error: groupText("attachments.pathUnavailable", locale),
            kind: "file",
          });
          continue;
        }
        next.push({
          id,
          name,
          mimeType,
          size,
          status: "ready",
          kind: "file",
          path,
        });
      }
      if (next.length > 0) {
        setAttachments((current) => [...current, ...next].slice(0, MAX_GROUP_ATTACHMENTS));
      }
      return next;
    },
    [setAttachments, locale],
  );

  const remove = useCallback(
    (id: string) => {
      setAttachments((current) => current.filter((item) => item.id !== id));
    },
    [setAttachments],
  );

  const clear = useCallback(() => setAttachments([]), [setAttachments]);

  const ready = attachments.filter((item) => item.status === "ready");
  const hasReady = ready.length > 0;
  const hasErrors = attachments.some((item) => item.status === "error");

  const toPromptAttachments = useCallback((): PromptImageAttachment[] => {
    return ready
      .filter((item) => item.kind === "image" && item.dataUrl)
      .map((item) => ({
        type: "image" as const,
        data: dataUrlPayload(item.dataUrl as string),
        mimeType: item.mimeType,
        name: item.name,
      }));
  }, [ready]);

  const toContextItems = useCallback((): GroupMessageContextItem[] => {
    return ready
      .filter((item): item is GroupComposerAttachment & { path: string } =>
        Boolean(item.kind === "file" && item.path),
      )
      .map((item) => ({ type: "file" as const, path: item.path }));
  }, [ready]);

  return {
    addFiles,
    attachments,
    clear,
    formatSize: formatAttachmentSize,
    hasErrors,
    hasReady,
    remove,
    toContextItems,
    toPromptAttachments,
  };
}
