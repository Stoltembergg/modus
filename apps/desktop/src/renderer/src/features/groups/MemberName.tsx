import type { MemberLabel } from "./memberLabels";

/** A member's title, with the muted short-id suffix when the title repeats in the group. */
export function MemberName({ label }: { label: MemberLabel }) {
  return (
    <>
      {label.title}
      {label.suffix ? (
        <span className="text-fg-faint" data-testid="member-id-suffix">
          {" "}
          · {label.suffix}
        </span>
      ) : null}
    </>
  );
}
