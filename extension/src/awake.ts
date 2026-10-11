/// <reference lib="dom" />
/**
 * Runs in the chat page's own world (not the extension's), from page start
 * and again before each message.
 *
 * A background tab gets no animation frames and says it is hidden, and some
 * chat sites (DeepSeek, ChatGPT) then stop drawing a streaming reply, so the
 * tab used to be brought to the front. Instead, in this page's world only:
 *
 *  - the page is told it is visible (`document.hidden` false, no
 *    `visibilitychange`), so "pause while hidden" logic never starts;
 *  - while the tab is really hidden, animation frames run from a timer and
 *    from ZX's own poll (a `zx-wake` event, sent every 700 ms), which
 *    background throttling does not slow down.
 *
 * The extension's own script runs in another world and still sees the truth.
 * A visible tab keeps the browser's real frames.
 */
(() => {
  const w = window as unknown as { __zxAwake?: () => void };
  if (w.__zxAwake !== undefined) return;

  const hiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")?.get;
  const reallyHidden = (): boolean => (hiddenGetter ? hiddenGetter.call(document) === true : false);

  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  // Our ids start high so they never match one the page got before this ran.
  let next = 1_000_000;
  const queued = new Map<number, FrameRequestCallback>();
  const live = new Map<number, { handle: number; callback: FrameRequestCallback }>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (queued.size === 0) return;
    const batch = [...queued.values()];
    queued.clear();
    const now = performance.now();
    for (const callback of batch) {
      try {
        callback(now);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  };
  const later = (): void => {
    timer ??= setTimeout(flush, 16);
  };

  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = next++;
    if (reallyHidden()) {
      queued.set(id, callback);
      later();
    } else {
      const handle = raf((time) => {
        live.delete(id);
        callback(time);
      });
      live.set(id, { handle, callback });
    }
    return id;
  };

  window.cancelAnimationFrame = (id: number): void => {
    if (queued.delete(id)) return;
    const frame = live.get(id);
    if (frame !== undefined) {
      live.delete(id);
      caf(frame.handle);
    } else {
      caf(id);
    }
  };

  const changed = (): void => {
    if (reallyHidden()) {
      // Frames asked for while visible would wait until the tab is shown again.
      for (const [id, frame] of live) {
        caf(frame.handle);
        queued.set(id, frame.callback);
      }
      live.clear();
      if (queued.size > 0) later();
    } else {
      flush();
    }
  };

  // The page always sees a visible tab; this script still reacts to the real change.
  for (const [name, value] of [
    ["hidden", false],
    ["webkitHidden", false],
    ["visibilityState", "visible"],
    ["webkitVisibilityState", "visible"],
  ] as const) {
    try {
      Object.defineProperty(Document.prototype, name, { get: () => value, configurable: true });
    } catch {
      // Not redefinable here; frames still keep running.
    }
  }
  const swallow = (event: Event): void => {
    changed();
    event.stopImmediatePropagation();
  };
  window.addEventListener("visibilitychange", swallow, true);
  document.addEventListener("visibilitychange", swallow, true);

  document.addEventListener("zx-wake", flush);
  w.__zxAwake = flush;
})();
