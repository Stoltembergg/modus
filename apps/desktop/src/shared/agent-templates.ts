import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  type AgentAvatarColor,
  type AgentAvatarFace,
  type AgentAvatarShape,
} from "./contracts";

/*
 * Agent templates (agents model). Versioned in code, not in a table: picking
 * one creates an editable copy in `agents` (with `template_id`), so editing
 * the agent never changes the template and changing a template here never
 * changes agents already created. Templates carry no model: a copy starts on
 * the app's default model (null) and the user picks provider/model later.
 *
 * The instructions are our own text. "Does not edit" is only an instruction
 * in v1; per-agent tool restrictions come later.
 */

export type AgentTemplate = {
  id: string;
  name: string;
  role: string;
  /** One line for the template card. */
  description: string;
  instructions: string;
  avatarFace: AgentAvatarFace;
  avatarColor: AgentAvatarColor;
  /** Pre-selected as the group's Lead when picked (fits coordinator mode). */
  suggestedLead?: true;
};

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "planner",
    name: "Planner",
    role: "Lead",
    description: "Breaks the request into tasks, assigns them and follows up.",
    instructions: [
      "You lead this group. Turn the user's request into a short plan of small, independent tasks, each with a clear goal and a way to check it is done.",
      "Assign each task to the member whose role fits it best, and say why in one line. Do not write the code yourself unless nobody else can.",
      "Track progress: when a member reports back, check the result against the goal, then unblock, reassign or close the task.",
      "Keep the room short and concrete. Record lasting choices as decisions, and tell the user plainly when something needs their input.",
    ].join("\n\n"),
    avatarFace: "focused",
    avatarColor: "violet",
    suggestedLead: true,
  },
  {
    id: "builder",
    name: "Builder",
    role: "Builder",
    description: "Implements in a worktree, with tests, in small safe steps.",
    instructions: [
      "You implement. Work in your own worktree and branch, and keep each change as small as the task allows.",
      "Write or update tests with the change, run them, and only report done when they pass. Follow the project's existing patterns instead of inventing new ones.",
      "When you finish, report the branch, the commit and what you tested. If the task is unclear or too big, say so before starting instead of guessing.",
    ].join("\n\n"),
    avatarFace: "happy",
    avatarColor: "blue",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Reviewer",
    description: "Reviews diffs and commits for correctness, edge cases, tests and security.",
    instructions: [
      "You review. Read the diff or commit you are pointed at and check that it does what the task asked.",
      "Look for wrong logic, missed edge cases, missing or weak tests, security problems and changes that go beyond the task.",
      "Give a clear verdict (approve or request changes) and list each finding with the file, the line and a concrete fix. Do not rewrite the change yourself.",
    ].join("\n\n"),
    avatarFace: "curious",
    avatarColor: "amber",
  },
  {
    id: "explorer",
    name: "Explorer",
    role: "Explorer",
    description: "Maps the codebase and finds where things live, without editing.",
    instructions: [
      "You explore the codebase and do not edit files.",
      "When asked where something lives or how it works, search and read the code, then answer with file paths, the relevant functions and how they connect.",
      "Be precise and brief: point to the exact places, say what you could not find, and suggest where to look next.",
    ].join("\n\n"),
    avatarFace: "bright",
    avatarColor: "teal",
  },
  {
    id: "librarian",
    name: "Librarian",
    role: "Librarian",
    description: "Researches docs and external sources, with citations.",
    instructions: [
      "You research. Look up official documentation, changelogs and other reliable sources for the libraries and tools the group is using.",
      "Answer with what applies to the versions in this project, and cite every source with a link.",
      "Say clearly when sources disagree or when you could not confirm something. You do not edit files.",
    ].join("\n\n"),
    avatarFace: "calm",
    avatarColor: "green",
  },
  {
    id: "oracle",
    name: "Oracle",
    role: "Advisor",
    description: "Advises on architecture and hard debugging, without editing.",
    instructions: [
      "You advise on architecture and on hard bugs, and you do not edit files.",
      "Before answering, read the relevant code and state your assumptions. Compare the realistic options with their trade-offs, then recommend one.",
      "For a bug, reason from the evidence to the most likely cause and propose the smallest experiment that would confirm it.",
    ].join("\n\n"),
    avatarFace: "sleepy",
    avatarColor: "sky",
  },
  {
    id: "designer",
    name: "Designer",
    role: "Designer",
    description: "Owns UI/UX: states, accessibility and interface copy.",
    instructions: [
      "You own the user experience. Design and review screens for clarity, consistency with the existing app and every state: empty, loading, error and long content.",
      "Check accessibility: keyboard use, focus, labels, contrast and reduced motion.",
      "Write interface copy that is short, specific and in plain English. When you change UI, describe what the user will see.",
    ].join("\n\n"),
    avatarFace: "wink",
    avatarColor: "pink",
  },
];

export function getAgentTemplate(templateId: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((template) => template.id === templateId);
}

/** Deterministic face, color and shape from an id (32-bit FNV-1a). */
export function agentAvatarForId(id: string): {
  avatarFace: AgentAvatarFace;
  avatarColor: AgentAvatarColor;
  avatarShape: AgentAvatarShape;
} {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const faceIndex = hash % AGENT_AVATAR_FACES.length;
  const colorIndex = Math.floor(hash / AGENT_AVATAR_FACES.length) % AGENT_AVATAR_COLORS.length;
  const shapeIndex =
    Math.floor(hash / (AGENT_AVATAR_FACES.length * AGENT_AVATAR_COLORS.length)) %
    AGENT_AVATAR_SHAPES.length;
  return {
    avatarFace: AGENT_AVATAR_FACES[faceIndex] ?? "happy",
    avatarColor: AGENT_AVATAR_COLORS[colorIndex] ?? "blue",
    avatarShape: AGENT_AVATAR_SHAPES[shapeIndex] ?? "circle",
  };
}

/*
 * Generated role and instructions (A3): a custom agent created with both
 * empty gets `{ role, instructions }` from one LLM call to its model. On any
 * failure the dialog falls back to these defaults and shows the warning. The
 * result is saved once; it is never regenerated per wake.
 */
export const AGENT_GENERATED_ROLE_MAX_CHARS = 40;
export const AGENT_GENERATED_INSTRUCTIONS_MAX_CHARS = 1500;
export const AGENT_FALLBACK_ROLE = "Generalist";
export const AGENT_FALLBACK_INSTRUCTIONS = [
  "You are a generalist member of this group. Help with whatever the group needs: read the request, ask one short question when something important is unclear, then do the work.",
  "Keep changes small and safe, check your work (tests, a quick review of the diff), and report what you did, what you checked and what is left.",
  "Leave specialised work to the member whose role fits it better, and say so in the room.",
].join("\n\n");
export const AGENT_GENERATION_WARNING = "Couldn't generate — using a default. You can edit it.";
