import { useEffect, useState } from "react";
import type { PermissionDecision, PermissionRequest } from "../../../../shared/contracts";
import { type ApprovalChoice, QuestionCard } from "../../components/question/QuestionCard";

type ApprovalDecision = PermissionDecision["decision"];

type ApprovalPanelProps = {
  request: PermissionRequest;
  onDecide(request: PermissionRequest, decision: ApprovalDecision): Promise<void> | void;
  /** Injectable clock for tests. */
  now?: () => number;
};

type ApprovalOption = ApprovalChoice & { id: ApprovalDecision };

const APPROVAL_OPTIONS: ApprovalOption[] = [
  {
    id: "allow-once",
    key: "1",
    title: "Yes, allow this time",
    description: "Run only this request, then ask again next time.",
  },
  {
    id: "allow-workspace",
    key: "2",
    title: "Yes, always allow in this project",
    description: "Trust this action target for the current workspace.",
  },
  {
    id: "deny",
    key: "3",
    title: "No, deny this request",
    description: "Block the tool call and let the agent continue safely.",
  },
];

export const APPROVAL_EXPIRED_MESSAGE =
  "This request expired and was denied automatically. The agent can ask again.";

function isInactiveError(caught: unknown): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /no longer active/i.test(message);
}

/**
 * Permission request card — thin adapter over the unified Question Tool card in
 * approval mode. The visible sentence is app-generated (`request.summary`);
 * the exact payload sits behind "Show details". Once the request expires the
 * card locks instead of letting Submit hit an inactive request.
 */
export function ApprovalPanel({ onDecide, request, now = Date.now }: ApprovalPanelProps) {
  const [expired, setExpired] = useState(
    () => request.expiresAt !== undefined && now() >= request.expiresAt,
  );

  useEffect(() => {
    if (expired || request.expiresAt === undefined) return;
    const remaining = request.expiresAt - now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expired, request.expiresAt, now]);

  const target = request.summary ? undefined : request.target.trim() || request.action;
  return (
    <QuestionCard
      approveLabel="Submit"
      badge={request.action}
      choices={APPROVAL_OPTIONS}
      defaultChoice="allow-once"
      denyChoice="deny"
      expiredMessage={APPROVAL_EXPIRED_MESSAGE}
      mode="approval"
      onDecide={async (choiceId) => {
        const option = APPROVAL_OPTIONS.find((item) => item.id === choiceId);
        if (!option) return;
        if (request.expiresAt !== undefined && now() >= request.expiresAt) {
          setExpired(true);
          return;
        }
        try {
          await onDecide(request, option.id);
        } catch (caught) {
          if (isInactiveError(caught)) {
            setExpired(true);
            return;
          }
          throw caught;
        }
      }}
      status={expired ? "expired" : "pending"}
      title={approvalTitle(request.action)}
      reason={request.summary ?? request.reason}
      {...(target ? { target } : {})}
      {...(request.details ? { details: request.details } : {})}
    />
  );
}

function approvalTitle(action: PermissionRequest["action"]): string {
  if (action === "mcp.call") return "Allow using this MCP tool?";
  if (action === "shell.execute") return "Allow running this command?";
  if (action === "git.write") return "Allow changing git state?";
  if (action === "file.write") return "Allow editing files?";
  if (action === "file.delete") return "Allow deleting files?";
  if (action === "browser.control") return "Allow controlling the browser?";
  return "Allow opening this external target?";
}
