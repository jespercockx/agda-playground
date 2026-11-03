import { Decoration } from "@codemirror/view";
import {
  clearHighlight,
  clearRunningInfo,
  emitRunningInfo,
  setGoals,
} from "./effects";
import {
  alsHighlightingInfosDirectSchema,
  alsInteractionPointsSchema,
} from "./schema";
import { buildHighlightEffects, highlightState } from "./highlight";
import { buildGoalTransaction, getAgdaGoalById } from "./goals";

/** @import { EditorView } from '@codemirror/view' */
/** @import { ALSMessageRouter } from './transport' */

/** @typedef Controller
 * @prop {boolean} checked
 * @prop {boolean} showImplicitArgs
 * @prop {boolean} showIrrelevantArgs
 * @prop {string | undefined} pendingExpression
 * @prop {number[]} interactionPoints
 * @prop {'give' | 'makeCase' | undefined} pendingInteraction
 * @prop {boolean} pendingInteractionReload
 * @prop {() => void} [onInteractionEdit]
 */

/**
 * Did Agda report an interaction point the editor did not know about before
 * this command? Give/refine report the resulting holes with ranges anchored at
 * the start of the file (see `InteractionPoints` below), so a new point means
 * we cannot place it from Agda's data.
 *
 * @param {number[]} previousIds
 * @param {Agda._InteractionPoint[]} current
 */
export function hasNewInteractionPoints(previousIds, current) {
  const known = new Set(previousIds);
  return current.some((ip) => !known.has(ip.id));
}

/** @typedef {(
 *  | 'ResponseHighlightingInfoDirect' | 'ResponseHighlightingInfoIndirect'
 *  | 'ResponseDisplayInfo' | 'ResponseStatus'
 *  | 'ResponseClearHighlightingTokenBased' | 'ResponseClearHighlightingNotOnlyTokenBased'
 *  | 'ResponseRunningInfo' | 'ResponseClearRunningInfo'
 *  | 'ResponseDoneAborting' | 'ResponseDoneExiting'
 *  | 'ResponseGiveAction' | 'ResponseInteractionPoints'
 *  | 'ResponseMakeCaseFunction' | 'ResponseMakeCaseExtendedLambda'
 *  | 'ResponseSolveAll' | 'ResponseMimer'
 *  | 'ResponseJumpToError' | 'ResponseJSONRaw')} ALSResponseType */

/**
 * @param {Controller} controller
 * @param {EditorView} editorView */
export function makeLSPResponseHandlerMap(controller, editorView) {
  /** @type {Partial<Record<ALSResponseType, (this: ALSMessageRouter, contents: any) => void>>} */
  const handlers = {
    ResponseStatus([checked, showImplicitArgs]) {
      controller.checked = checked;
      controller.showImplicitArgs = showImplicitArgs;
      // controller.showIrrelevantArgs = showIrrelevantArgs
    },
    ResponseClearHighlightingTokenBased() {
      // @ts-ignore
      return rawJsonHandlers.ClearHighlighting({ tokenBased: "TokenBased" });
    },
    ResponseClearHighlightingNotOnlyTokenBased() {
      // @ts-ignore
      return rawJsonHandlers.ClearHighlighting({
        tokenBased: "NotOnlyTokenBased",
      });
    },
    ResponseHighlightingInfoDirect(contents) {
      const infos = alsHighlightingInfosDirectSchema.decode(contents);
      // @ts-ignore
      return rawJsonHandlers.HighlightingInfo(infos);
    },
    ResponseInteractionPoints(contents) {
      const ids = alsInteractionPointsSchema.decode(contents);
      /** @type {import("@codemirror/state").Range<Decoration>[]} */
      const decos = [];

      // we can map CM's data back to Agda's ranges but it is too much work
      const holes = editorView.state.field(highlightState).otherAspects.update({
        filter: (_ff, _tt, value) => value.spec.isHole,
      });

      // we do not rely on the property that filter is queried in order
      if (holes.size !== ids.length) {
        throw new Error(
          `mismatched numbers of interaction points ${ids.length} and holes ${holes.size}`,
        );
      }

      for (let it = holes.iter(), idx = 0; it.value !== null; it.next()) {
        const { value, from, to } = it;
        value.spec.id = ids[idx++];
        decos.push(value.range(from, to));
      }

      editorView.dispatch({
        effects: setGoals.of(decos),
      });
    },
    ResponseJSONRaw(/** @type {Agda._Resp} */ contents) {
      const handler = rawJsonHandlers[contents.kind];
      if (handler) {
        return handler(/** @type {any} */ (contents));
      }
      // DisplayInfo is rendered by the playground controller rather than by
      // CodeMirror, so it is intentionally passed through unchanged.
      if (contents.kind === "DisplayInfo") return;
      console.warn("unrecognized raw response", contents);
    },
  };

  /** @type {Partial<{[k in Agda._Resp['kind']]: (resp: Extract<Agda._Resp, {kind: k}>) => void}>} */
  const rawJsonHandlers = {
    Status({
      status: { checked, showImplicitArguments, showIrrelevantArguments },
    }) {
      controller.checked = checked;
      controller.showImplicitArgs = showImplicitArguments;
      controller.showIrrelevantArgs = showIrrelevantArguments;
    },
    ClearRunningInfo() {
      editorView.dispatch({ effects: clearRunningInfo.of() });
    },
    RunningInfo({ message, debugLevel }) {
      editorView.dispatch({
        effects: emitRunningInfo.of({ message, debugLevel }),
      });
    },
    ClearHighlighting({ tokenBased }) {
      // Agda (~2.8)'s codebase does not contain any instance of (Resp_ClearHighlighting TokenBased)
      if (tokenBased === "TokenBased") {
        throw new Error("(ClearHighlighting TokenBased) is not implemented");
        // editorView.dispatch({
        //   effects: clearHighlight.of(true),
        // })
      } else {
        // clear not-only-token-based
        editorView.dispatch({
          effects: clearHighlight.of(false),
        });
      }
    },
    HighlightingInfo({ direct, info }) {
      if (!direct) {
        throw new Error("indrect highlighting is not implemented");
      }
      // Agda (~2.8)'s codebase does not contain any instance of (Resp_HighlightingInfo ... RemoveHighlighting)
      if (info.remove) {
        editorView.dispatch({
          effects: clearHighlight.of(true),
        });
      }
      editorView.dispatch({
        effects: buildHighlightEffects(editorView.state, info.payload),
      });
    },
    InteractionPoints({ interactionPoints }) {
      const pending = controller.pendingInteraction;
      controller.pendingInteraction = undefined;

      // Goals are placed from the ranges Agda reports, but two commands leave
      // those ranges pointing at the wrong place:
      //
      // - Give/refine parse the expression from `startPos` because the client
      //   sends `noRange` (see `Controller.give`), so a hole the expression
      //   introduces is reported at the start of the file, not where it was
      //   inserted.
      // - Case-split rewrites whole clauses, so the surviving ranges belong to
      //   the pre-split text.
      //
      // Emacs sidesteps both by re-scanning the buffer for `?`/`{! !}` after
      // every response instead of trusting these ranges; here we re-check the
      // file, which re-parses the inserted `?` at its real position. Revisit
      // if the extra check proves too frequent or too slow.
      if (pending === "makeCase") {
        controller.pendingInteractionReload = true;
        return;
      }
      if (
        pending === "give" &&
        hasNewInteractionPoints(controller.interactionPoints, interactionPoints)
      ) {
        controller.pendingInteractionReload = true;
        return;
      }

      editorView.dispatch(
        buildGoalTransaction(editorView.state, interactionPoints),
      );
    },
    GiveAction({ interactionPoint, giveResult }) {
      const ip = /** @type {any} */ (interactionPoint);
      const id = typeof ip === "number" ? ip : ip?.id;
      const goal = getAgdaGoalById(editorView.state, id);
      if (!goal) return;

      let replacement;
      if ("str" in giveResult) {
        replacement = giveResult.str;
      } else {
        replacement = controller.pendingExpression ?? "";
        if (giveResult.paren) replacement = `(${replacement})`;
      }

      editorView.dispatch({
        changes: { from: goal.from, to: goal.to, insert: replacement },
        selection: { anchor: goal.from + replacement.length },
      });
      controller.pendingInteraction = "give";
      controller.onInteractionEdit?.();
    },
    MakeCase({ interactionPoint, clauses }) {
      const ip = /** @type {any} */ (interactionPoint);
      const id = typeof ip === "number" ? ip : ip?.id;
      const goal = getAgdaGoalById(editorView.state, id);
      if (!goal || !Array.isArray(clauses) || clauses.length === 0) return;

      const line = editorView.state.doc.lineAt(goal.from);
      const indentation = line.text.match(/^\s*/)?.[0] ?? "";
      const source = clauses
        .map((clause, index) =>
          index === 0 ? String(clause) : indentation + String(clause),
        )
        .join("\n");

      editorView.dispatch({
        changes: { from: line.from, to: line.to, insert: source },
        selection: { anchor: line.from + source.length },
      });
      controller.pendingInteraction = "makeCase";
      controller.onInteractionEdit?.();
    },
  };

  return handlers;
}
