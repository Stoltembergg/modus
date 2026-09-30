/**
 * Whether clicking a group member in the sidebar should open the **group**
 * pane (room-active: waiting / working) or the agent's idle **1:1** chat.
 */
export function groupMemberOpenTarget(room: "waiting" | "working" | "idle"): "group" | "chat" {
  return room === "waiting" || room === "working" ? "group" : "chat";
}
