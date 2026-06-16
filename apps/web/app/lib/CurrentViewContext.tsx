import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type CurrentViewEntityType =
  | "agent"
  | "skill"
  | "settings"
  | "team"
  | "task"
  | null;

/** What the user is currently looking at, published by each route and read by
 *  the ambient Acme panel so it can carry the live view (incl. unsaved form
 *  edits) into the conversation. `content` is the actual entity/draft object. */
export interface CurrentView {
  /** Route pathname, e.g. "/agents". */
  page: string;
  entityType: CurrentViewEntityType;
  /** Focused entity id (agent/skill/team/task), or null. */
  entityId: string | null;
  /** Active sub-tab where the page has one (detail tab / settings tab). */
  tab?: string | null;
  /** The live entity or form draft in view — the panel renders/serializes this. */
  content?: unknown;
}

const Ctx = createContext<{
  view: CurrentView | null;
  setView: (v: CurrentView | null) => void;
} | null>(null);

export function CurrentViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<CurrentView | null>(null);
  const value = useMemo(() => ({ view, setView }), [view]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the current view (the ambient Acme panel). Null outside the provider. */
export function useCurrentView(): CurrentView | null {
  return useContext(Ctx)?.view ?? null;
}

/**
 * Publish the current view from a route. Pass the live view object (memoize it
 * in the caller so this only fires when something actually changes). Clears on
 * unmount so navigating away drops stale context.
 */
export function usePublishCurrentView(view: CurrentView | null): void {
  const ctx = useContext(Ctx);
  const setView = ctx?.setView;
  // Serialize the identifying fields for a cheap dep (content can be a large/
  // unstable object; we re-publish whenever page/entity/tab change OR the
  // caller passes a new memoized `view`).
  useEffect(() => {
    if (!setView) return;
    setView(view);
    return () => setView(null);
  }, [setView, view]);
}
