import { useMemo } from "react";
import type { QuestionAnswer, QuestionRequest } from "../../../../shared/contracts";
import { groupStatusLabel } from "../../../../shared/group-room-locale";
import { QuestionCard } from "../../components/question/QuestionCard";
import { latestPendingQuestionRequest } from "../agent/questionRequests";
import { useGroupAgentEvents } from "./groupAgentEvents";
import { useGroupRoomLocale } from "./groupRoomI18n";
import { type MemberLabel, memberLabelText } from "./memberLabels";

/**
 * Pending ask_user / intent-gate questions for group_member sessions that are
 * "Waiting for you". Rendered in the group room so answers stay group-scoped
 * instead of diverting the pane to a private member session.
 */
export function useGroupMemberQuestions(
  waitingSessionIds: readonly string[],
): Map<string, QuestionRequest> {
  const eventsBySession = useGroupAgentEvents("group-questions", waitingSessionIds, "questions");

  return useMemo(() => {
    const pending = new Map<string, QuestionRequest>();
    for (const [sessionId, events] of eventsBySession) {
      if (!waitingSessionIds.includes(sessionId)) continue;
      const request = latestPendingQuestionRequest(events);
      if (request) pending.set(sessionId, request);
    }
    return pending;
  }, [eventsBySession, waitingSessionIds]);
}

export function GroupMemberQuestions({
  waitingSessionIds,
  labels,
}: {
  waitingSessionIds: readonly string[];
  labels: ReadonlyMap<string, MemberLabel>;
}) {
  const pending = useGroupMemberQuestions(waitingSessionIds);
  const locale = useGroupRoomLocale();
  if (pending.size === 0) return null;

  async function respond(
    request: QuestionRequest,
    answers: QuestionAnswer[],
    skipped: boolean,
  ): Promise<void> {
    await window.modus.questions.respond({ requestId: request.id, answers, skipped });
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[760px] flex-col gap-2 px-6 pb-2"
      data-testid="group-member-questions"
    >
      {[...pending.entries()].map(([sessionId, request]) => {
        const label = labels.get(sessionId);
        const name = label ? memberLabelText(label) : sessionId;
        return (
          <div data-member-session={sessionId} key={request.id}>
            <div className="mb-1.5 text-2xs text-fg-faint">
              {name} · {groupStatusLabel("waitingForYou", locale)}
            </div>
            <QuestionCard
              mode="question"
              onSkip={() => respond(request, [], true)}
              onSubmit={(answers) => respond(request, answers, false)}
              questions={request.questions}
            />
          </div>
        );
      })}
    </div>
  );
}
