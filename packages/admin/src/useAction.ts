import { useCallback, useEffect, useRef, useState } from "react";
import { getAction, postAction } from "./api.js";
import type { ActionInput, ActionRecord } from "./types.js";

/**
 * Starts one action and polls it every second until it ends. The last action stays on screen; the
 * callback refreshes the bricks once it is over.
 */
export function useAction(onFinished: () => void) {
  const [id, setId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [action, setAction] = useState<ActionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const run = useCallback(async (input: ActionInput) => {
    setError(null);
    setPending(true);
    try {
      const started = await postAction(input);
      setAction(null);
      setId(started.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const a = await getAction(id);
        if (cancelled) return;
        setAction(a);
        if (a.state !== "running") {
          setId(null);
          finished.current();
          return;
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setId(null);
        }
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id]);

  return { run, action, error, busy: pending || id !== null };
}
