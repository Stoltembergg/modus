import { useEffect, useMemo, useState } from "react";
import type { AgentEventItem } from "../../../../shared/agent-events";
import type { AgentEvent, QuestionAnswer, QuestionRequest } from "../../../../shared/contracts";
import { latestPendingQuestionRequest } from "../agent/questionRequests";
import { QuestionsCard } from "../plan/QuestionsCard";
import { type MemberLabel, memberLabelText } from "./memberLabels";

/**
 * Pending ask_user / intent-gate questions for group_member sessions that are
 * "Waiting for you". Rendered in the group room so answers stay group-scoped
 * instead of diverting the pane to a private member session.
 */
export function useGroupMemberQuestions(
  waitingSessionIds: readonly string[],
): Map<string, QuestionRequest> {
  const [eventsBySession, setEventsBySession] = useState<
    ReadonlyMap<string, Array<{ event: AgentEvent }>>
  >(() => new Map());
  const waitingKey = waitingSessionIds.slice().sort().join("|");

  useEffect(() => {
    const ids = waitingKey ? waitingKey.split("|") : [];
    if (ids.length === 0) {
      setEventsBySession(new Map());
      return;
    }
    let cancelled = false;

    void Promise.all(
      ids.map(async (sessionId) => {
        try {
          const items = (await window.modus.agent.listEvents(sessionId)) as AgentEventItem[];
          const events: Array<{ event: AgentEvent }> = items.map((item) => ({ event: item.event }));
          return [sessionId, events] as const;
        } catch {
          const empty: Array<{ event: AgentEvent }> = [];
          return [sessionId, empty] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setEventsBySession(new Map(entries));
    });

    const unsubscribe = window.modus.agent.onEvent((event: AgentEvent) => {
      if (event.type !== "question.requested" && event.type !== "question.resolved") return;
      if (!ids.includes(event.sessionId)) return;
      setEventsBySession((current) => {
        const next = new Map(current);
        const list = next.get(event.sessionId) ?? [];
        next.set(event.sessionId, [...list, { event }]);
        return next;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [waitingKey]);

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
            <div className="mb-1.5 text-2xs text-fg-faint">{name} · Waiting for you</div>
            <QuestionsCard
              onSkip={() => void respond(request, [], true)}
              onSubmit={(answers) => void respond(request, answers, false)}
              request={request}
            />
          </div>
        );
      })}
    </div>
  );
}
