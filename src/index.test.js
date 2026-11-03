/// <reference types="vitest/globals" />

import { CompletionContext, acceptCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  agdaCompletionSource,
  agdaCompletions,
} from "$lib/codemirror/completion";
import { browserAgdaSource } from "$lib/agda/browser-source";
import { hasNewInteractionPoints } from "$lib/agda/handlers";
import config from "../playground.config.json";

function complete(source, explicit = true) {
  const state = EditorState.create({ doc: source });
  return agdaCompletionSource(
    new CompletionContext(state, state.doc.length, explicit),
  );
}

describe("Agda completion", () => {
  it("suggests names declared in the current buffer", () => {
    const result = complete("identity : Set\nidentity = Set\niden");
    expect(result.options.map((option) => option.label)).toContain("identity");
    expect(result.options.map((option) => option.label)).not.toContain("iden");
  });

  it("suggests exports from open builtin imports", () => {
    const result = complete("open import Agda.Builtin.Bool\ntr");
    expect(result.options.map((option) => option.label)).toContain("true");
  });

  it("accepts completions with Tab instead of Enter", () => {
    const state = EditorState.create({ extensions: agdaCompletions() });
    const bindings = state.facet(keymap).flat();
    expect(bindings.find((binding) => binding.key === "Tab")?.run).toBe(
      acceptCompletion,
    );
    expect(
      bindings.some(
        (binding) => binding.key === "Enter" && binding.run === acceptCompletion,
      ),
    ).toBe(false);
  });
});

describe("content import rewrite", () => {
  it("is the identity without a rewrite spec", () => {
    const source = `module Main where
open import Data.Product using (_×_)
answer = {!  !}
`;
    expect(
      browserAgdaSource("/Main.agda", source, config.importRewrite),
    ).toBe(source);
  });
});

describe("interaction-point reload decision", () => {
  it("detects holes introduced by a give or refine", () => {
    expect(hasNewInteractionPoints([0], [{ id: 0 }, { id: 1 }])).toBe(true);
    expect(hasNewInteractionPoints([2, 5], [{ id: 2 }, { id: 5 }])).toBe(false);
    expect(hasNewInteractionPoints([], [{ id: 3 }])).toBe(true);
  });
});
