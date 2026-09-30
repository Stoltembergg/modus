/**
 * Whether clicking a group member in the sidebar should open the **group**
 * pane (member Waiting for you) or the agent's idle/working **1:1** chat.
 * Waiting is the diversion case (ask_user / intent gate); keep that in-room.
 */
export function groupMemberOpenTarget(room: "waiting" | "working" | "idle"): "group" | "chat" {
  return room === "waiting" ? "group" : "chat";
}
