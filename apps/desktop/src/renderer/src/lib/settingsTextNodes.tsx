import { Fragment, type ReactNode } from "react";

/**
 * Fills `{name}` slots in an already translated string with React nodes, so a
 * sentence with inline code or links stays ONE catalog entry that each
 * language can order freely: `textWithNodes(t("x"), { file: <code>A.md</code> })`.
 * Slots without a node are left as written.
 */
export function textWithNodes(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const parts = text.split(/(\{\w+\})/);
  return parts.map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const node = name !== undefined && name in nodes ? nodes[name] : part;
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
    return <Fragment key={index}>{node}</Fragment>;
  });
}
