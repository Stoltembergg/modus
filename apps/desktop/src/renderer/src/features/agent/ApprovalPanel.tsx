import type { PermissionDecision, PermissionRequest } from "../../../../shared/contracts";
import { type ApprovalChoice, QuestionCard } from "../../components/question/QuestionCard";

type ApprovalDecision = PermissionDecision["decision"];

type ApprovalPanelProps = {
  request: PermissionRequest;
  onDecide(request: PermissionRequest, decision: ApprovalDecision): Promise<void> | void;
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

/**
 * Permission request card — thin adapter over the unified Question Tool card in
 * approval mode. Keys 1–3 pick an option, Enter submits it, Escape / Deny send
 * "deny"; a rejected onDecide re-enables the card and shows the error.
 */
export function ApprovalPanel({ onDecide, request }: ApprovalPanelProps) {
  const target = request.target.trim() || request.action;
  return (
    <QuestionCard
      approveLabel="Submit"
      badge={request.action}
      choices={APPROVAL_OPTIONS}
      defaultChoice="allow-once"
      denyChoice="deny"
      mode="approval"
      onDecide={(choiceId) => {
        const option = APPROVAL_OPTIONS.find((item) => item.id === choiceId);
        return option ? onDecide(request, option.id) : undefined;
      }}
      reason={request.reason}
      target={target}
      title={approvalTitle(request.action)}
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
