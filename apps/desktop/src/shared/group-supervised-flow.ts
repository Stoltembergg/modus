/**
 * Supervised code flow for Coordinator mode (execution goal item 5).
 *
 * When the Lead is coordinating a code-shaped ask: plan → implement → review →
 * deliver. Stages skip when unnecessary. Non-skipped implement/review stages
 * require real delegation through group_handoff / group_assign_task so Builder
 * and Reviewer actually wake — @mentions alone do not.
 */

export const SUPERVISED_FLOW_STAGES = ["plan", "implement", "review", "deliver"] as const;

export type SupervisedFlowStageId = (typeof SUPERVISED_FLOW_STAGES)[number];

export type SupervisedAskKind =
  | "social"
  | "question"
  | "docs"
  | "trivial"
  | "design"
  | "review-only"
  | "code";

export type SupervisedFlowMember = {
  sessionId: string;
  title: string;
  role?: string;
  archived?: boolean;
};

export type SupervisedFlowStage = {
  id: SupervisedFlowStageId;
  /** When true, the Lead must not spend a hop on this stage. */
  skip: boolean;
  reason?: string;
  ownerSessionId?: string;
  ownerName?: string;
};

export type SupervisedDelegation = {
  stage: Extract<SupervisedFlowStageId, "implement" | "review">;
  /** Existing group tools — supervised path must use these, not raw @wakes. */
  tool: "group_handoff" | "group_assign_task" | "group_request_review";
  memberId: string;
  memberName: string;
  objective: string;
};

export type SupervisedFlowPlan = {
  /** False when Coordinator should not run the supervised pipeline. */
  applies: boolean;
  kind: SupervisedAskKind;
  stages: SupervisedFlowStage[];
  /** Tool calls the Lead must make for active implement/review stages. */
  delegations: SupervisedDelegation[];
};

const SOCIAL_RE =
  /^(hi|hello|hey|yo|sup|thanks|thank you|thx|cheers|gm|good\s+(morning|afternoon|evening)|howdy|hola|oi|ol[aá]|bom\s+dia|boa\s+(tarde|noite)|tudo\s+bem|e\s+a[ií]|fala|salve)([!.\s].*)?$/iu;

const DOCS_RE =
  /\b(readme|changelog|docs?|documentation|markdown|\.md\b|typo in docs|comment[s]? only|jsdoc|docstring)\b/i;

const TRIVIAL_RE =
  /\b(typo|rename|nit|one[- ]liner|trivial|whitespace|format(ting)? only|lint fix)\b/i;

const DESIGN_RE =
  /\b(design|approach|architect(ure)?|strategy|propose|proposal|plan only|spec only|how should we)\b/i;

const REVIEW_ONLY_RE =
  /\b(review (this|the|my)|code review|lgtm|look over (this|the)|feedback on (this|the|pr|diff))\b/i;

const CODE_RE =
  /\b(implement|implementation|fix|bug|feature|refactor|patch|code|build|write|add|create|ship|deploy|test|pr|pull request|compile|runtime|api|endpoint|component|hook|module|class|function)\b/i;

const QUESTION_RE = /^(what|why|how|when|where|who|which|can you (explain|tell)|do you know)\b/i;

function haystack(member: SupervisedFlowMember): string {
  return [member.title, member.role].filter(Boolean).join(" ").toLocaleLowerCase();
}

function findMember(
  members: readonly SupervisedFlowMember[],
  patterns: RegExp[],
  exclude?: string,
): SupervisedFlowMember | undefined {
  return members.find((member) => {
    if (member.archived || member.sessionId === exclude) return false;
    const text = haystack(member);
    return patterns.some((pattern) => pattern.test(text));
  });
}

/** Classify a user ask for supervised-flow skip decisions. */
export function classifySupervisedAsk(body: string): SupervisedAskKind {
  const text = body
    .replace(/@[\p{L}\p{N}_.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "social";
  const lower = text.toLocaleLowerCase();
  if (text.length <= 80 && SOCIAL_RE.test(lower) && !CODE_RE.test(lower)) return "social";
  if (REVIEW_ONLY_RE.test(text) && !/\b(implement|fix|build|add|create)\b/i.test(text)) {
    return "review-only";
  }
  if (
    DOCS_RE.test(text) &&
    !/\b(implement|refactor|runtime|api|endpoint|component)\b/i.test(text)
  ) {
    return "docs";
  }
  if (TRIVIAL_RE.test(text) && text.length < 160) return "trivial";
  if (DESIGN_RE.test(text) && !/\b(implement|fix|code|build|patch)\b/i.test(text)) {
    return "design";
  }
  if (CODE_RE.test(text)) return "code";
  if (QUESTION_RE.test(lower) && text.length < 200 && !CODE_RE.test(text)) return "question";
  // Default: treat substantive asks as code work under Coordinator.
  if (text.length > 40) return "code";
  return "question";
}

function skipMap(kind: SupervisedAskKind): Record<SupervisedFlowStageId, string | undefined> {
  switch (kind) {
    case "docs":
      return {
        plan: undefined,
        implement: undefined,
        review: "docs-only ask — Reviewer not required",
        deliver: undefined,
      };
    case "trivial":
      return {
        plan: "trivial change — Lead can skip formal planning",
        implement: undefined,
        review: "trivial change — Reviewer not required",
        deliver: undefined,
      };
    case "design":
      return {
        plan: undefined,
        implement: "design/plan ask — no implementation yet",
        review: "no code change to review",
        deliver: undefined,
      };
    case "review-only":
      return {
        plan: "review-only ask — planning already done",
        implement: "review-only ask — no new implementation",
        review: undefined,
        deliver: undefined,
      };
    case "code":
      return { plan: undefined, implement: undefined, review: undefined, deliver: undefined };
    default:
      return {
        plan: "not a supervised code task",
        implement: "not a supervised code task",
        review: "not a supervised code task",
        deliver: "not a supervised code task",
      };
  }
}

/**
 * Plan the supervised pipeline for a Coordinator Lead wake.
 * Returns `applies: false` for social / questions / non-code asks.
 */
export function planSupervisedCodeFlow(input: {
  body: string;
  members: readonly SupervisedFlowMember[];
  leadSessionId: string;
}): SupervisedFlowPlan {
  const kind = classifySupervisedAsk(input.body);
  const applies =
    kind === "code" ||
    kind === "docs" ||
    kind === "trivial" ||
    kind === "design" ||
    kind === "review-only";
  const skips = skipMap(kind);
  const eligible = input.members.filter((member) => !member.archived);
  const lead = eligible.find((member) => member.sessionId === input.leadSessionId) ?? eligible[0];
  const builder = findMember(
    eligible,
    [/build/, /implement/, /dev/, /engineer/, /coder/],
    input.leadSessionId,
  );
  const reviewer = findMember(eligible, [/review/, /qa/, /verif/], input.leadSessionId);

  const owners: Record<SupervisedFlowStageId, SupervisedFlowMember | undefined> = {
    plan: lead,
    implement: builder ?? lead,
    review: reviewer ?? lead,
    deliver: lead,
  };

  const stages: SupervisedFlowStage[] = SUPERVISED_FLOW_STAGES.map((id) => {
    const reason = skips[id];
    const owner = owners[id];
    return {
      id,
      skip: Boolean(reason),
      ...(reason ? { reason } : {}),
      ...(owner ? { ownerSessionId: owner.sessionId, ownerName: owner.title } : {}),
    };
  });

  const delegations: SupervisedDelegation[] = [];
  if (applies) {
    const implement = stages.find((stage) => stage.id === "implement");
    if (implement && !implement.skip && builder && implement.ownerSessionId === builder.sessionId) {
      delegations.push({
        stage: "implement",
        tool: "group_handoff",
        memberId: builder.sessionId,
        memberName: builder.title,
        objective: "Implement the agreed plan in a worktree with tests.",
      });
    }
    const review = stages.find((stage) => stage.id === "review");
    if (review && !review.skip && reviewer && review.ownerSessionId === reviewer.sessionId) {
      delegations.push({
        stage: "review",
        tool: "group_request_review",
        memberId: reviewer.sessionId,
        memberName: reviewer.title,
        objective: "Review the implementation for correctness, tests, and scope.",
      });
    }
  }

  return { applies, kind, stages, delegations };
}

/** Prompt block injected into the coordinating Lead's wake. */
export function composeSupervisedFlowSection(plan: SupervisedFlowPlan): string {
  if (!plan.applies) return "";
  const lines = [
    "<supervised_flow>",
    "Supervised code flow (Coordinator): plan → implement → review → deliver.",
    "Skip stages marked skip. For active implement/review stages you MUST wake the owner through group_handoff / group_assign_task / group_request_review (session IDs below) — public @mentions do not wake peers.",
    `Ask kind: ${plan.kind}`,
    "Stages:",
  ];
  for (const stage of plan.stages) {
    const owner = stage.ownerName
      ? `@${stage.ownerName}${stage.ownerSessionId ? ` (id ${stage.ownerSessionId})` : ""}`
      : "unassigned";
    if (stage.skip) {
      lines.push(`- ${stage.id}: SKIP — ${stage.reason ?? "unnecessary"} (would be ${owner})`);
    } else {
      lines.push(`- ${stage.id}: RUN — owner ${owner}`);
    }
  }
  if (plan.delegations.length > 0) {
    lines.push("Required delegations (use these tools):");
    for (const delegation of plan.delegations) {
      lines.push(
        `- ${delegation.stage}: ${delegation.tool}(memberId=${delegation.memberId} /* @${delegation.memberName} */, objective=${JSON.stringify(delegation.objective)})`,
      );
    }
  } else {
    lines.push(
      "Required delegations: none (skipped implement/review, or no Builder/Reviewer member).",
    );
  }
  lines.push("</supervised_flow>");
  return lines.join("\n");
}
