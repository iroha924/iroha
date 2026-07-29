import { useRef } from "react";
import { type Location, useLocation } from "react-router-dom";

interface ModalLocationState {
  backgroundLocation?: Location;
}

function backgroundOf(location: Location): Location | undefined {
  return (location.state as ModalLocationState | null)?.backgroundLocation;
}

/**
 * The page a `/knowledge/:id` dialog is layered over, or `undefined` when the
 * detail has to stand on its own.
 *
 * Carrying the state is not sufficient. `history.state` survives a reload — and
 * react-router restores both `usr` and `key` from it — so a reloaded dialog URL
 * still arrives with a background and would re-open the dialog over a page this
 * document never navigated from. Requiring the location to have moved since the
 * document loaded is what makes a reload, a bookmark, and a shared link all fall
 * back to the full page that keeps the URL worth sharing.
 *
 * Call this once, from a component mounted for the document's lifetime: the
 * comparison is against wherever *that* component first rendered.
 */
export function useBackgroundLocation(): Location | undefined {
  const location = useLocation();
  const initialKey = useRef(location.key).current;
  return location.key === initialKey ? undefined : backgroundOf(location);
}

/**
 * Link state that layers the detail over what is already on screen. Following a
 * relation from inside the dialog reuses the background already stashed, so the
 * stack stays one deep instead of growing a dialog per hop.
 */
export function useModalLinkState(): ModalLocationState {
  const location = useLocation();
  return { backgroundLocation: backgroundOf(location) ?? location };
}
