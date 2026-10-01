import type { MessageBlockItem, TimelineBlock, WorkFoldBlockItem, WorkFoldItem } from "./Timeline";

export type TimelinePresentation = {
  transcriptBlocks: TimelineBlock[];
  activityBlocks: TimelineBlock[];
};

function isUserMessage(item: WorkFoldItem): item is MessageBlockItem {
  return item.type === "message" && item.role === "user";
}

/**
 * Split the runtime timeline into the durable conversation and its execution
 * record. Prompts and settled assistant answers stay in chat; all run, tool,
 * thought, queue, error, and in-progress assistant detail stays in Activity.
 * Source blocks are immutable inputs owned by the event projection.
 */
export function splitTimelinePresentation(blocks: readonly TimelineBlock[]): TimelinePresentation {
  const transcriptBlocks: TimelineBlock[] = [];
  const activityBlocks: TimelineBlock[] = [];

  for (const block of blocks) {
    if (block.type === "message") {
      if (block.role === "user" || !block.streaming) transcriptBlocks.push(block);
      else activityBlocks.push(block);
      continue;
    }

    if (block.type === "work-fold") {
      const activityItems: WorkFoldItem[] = [];
      for (const item of block.items) {
        if (isUserMessage(item)) transcriptBlocks.push(item);
        else activityItems.push(item);
      }
      activityBlocks.push({ ...block, items: activityItems } satisfies WorkFoldBlockItem);
      continue;
    }

    activityBlocks.push(block);
  }

  return { transcriptBlocks, activityBlocks };
}
