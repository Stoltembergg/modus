import { createHash } from "node:crypto";
import type { PromptSection } from "./prompt-section";

/**
 * Computes a deterministic SHA-256 fingerprint for a section's text content.
 */
export function fingerprintSection(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Detects which prompt sections have changed since they were last marked as sent for a session.
 * Volatile sections are always treated as changed.
 */
export function detectChanges(
  previousFingerprints: Map<string, string>,
  currentSections: Map<string, PromptSection>
): string[] {
  const changed: string[] = [];

  for (const [id, section] of currentSections.entries()) {
    if (section.volatile) {
      changed.push(id);
    } else {
      const prev = previousFingerprints.get(id);
      if (!prev || prev !== section.fingerprint) {
        changed.push(id);
      }
    }
  }

  return changed;
}
