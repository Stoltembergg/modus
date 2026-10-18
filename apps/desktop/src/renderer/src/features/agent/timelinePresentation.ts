import { toolRenderKind } from "../../../../shared/tools";
import type {
  MessageBlockItem,
  TimelineBlock,
  ToolBlockItem,
  WorkFoldBlockItem,
  WorkFoldItem,
} from "./Timeline";

export type TimelinePresentation = {
  transcriptBlocks: TimelineBlock[];
  activityBlocks: TimelineBlock[];
};

function isUserMessage(item: WorkFoldItem): item is MessageBlockItem {
  return item.type === "message" && item.role === "user";
}

/**
 * Split the runtime timeline into the durable conversation and its execution
 * record. Prompts, settled answers and delivered visuals stay in chat; technical
 * detail stays in Activity, with a summary for visuals rendered in the conversation.
 * Source blocks are immutable inputs owned by the event projection.
 */
export function splitTimelinePresentation(blocks: readonly TimelineBlock[]): TimelinePresentation {
  const transcriptBlocks: TimelineBlock[] = [];
  const activityBlocks: TimelineBlock[] = [];

  const projectTool = (tool: ToolBlockItem): ToolBlockItem => {
    if (toolRenderKind(tool.name) !== "visual") return tool;
    if (!tool.isError) transcriptBlocks.push(tool);
    return { ...tool, summaryOnly: true };
  };

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
        else if (item.type === "tool") activityItems.push(projectTool(item));
        else if (item.type === "work-activity-group") {
          activityItems.push({
            ...item,
            items: item.items.map((activity) =>
              activity.type === "tool" ? projectTool(activity) : activity,
            ),
          });
        } else activityItems.push(item);
      }
      activityBlocks.push({ ...block, items: activityItems } satisfies WorkFoldBlockItem);
      continue;
    }

    activityBlocks.push(block.type === "tool" ? projectTool(block) : block);
  }

  return { transcriptBlocks, activityBlocks };
}
