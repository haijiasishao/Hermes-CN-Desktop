import { atom } from "jotai";

export interface ComposerDraftSignal {
  text: string;
  nonce: number;
}

/**
 * External draft → PanelComposer prefill bridge.
 * External routes write; PanelComposer listens (effect on `nonce`) and pushes
 * the text into GooseComposer via its `initial` prop. `nonce` lets the same
 * draft re-trigger a prefill after the user edits and clicks again.
 */
export const composerPrefillAtom = atom<ComposerDraftSignal | null>(null);
