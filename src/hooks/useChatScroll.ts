// Scroll controller for a streaming chat transcript.
//
// Principles: never move the reader against intent; follow the live edge only
// while they're at it; seat a new turn near the top and let the answer stream
// into the space below, eating it; make it easy to return.
//
// Layout contract (see App): the transcript is bottom-aligned (justify-end) and
// a trailing spacer, present ONLY while streaming, is sized so
//   spacer = viewport − currentTurnHeight − contextGap.
// Because content + spacer then equals one viewport, "scroll to the scrollHeight
// bottom" simultaneously means (a) the newest user turn sits contextGap below
// the top and (b) the answer's live edge is in view. As the answer streams the
// spacer shrinks by exactly the new content, so scrollHeight stays put and the
// live edge marches DOWN through the reserved space — the whitespace is eaten,
// not pushed. At rest the spacer is 0, so the transcript simply bottom-aligns.
//
// Follow only ever scrolls DOWN; a `following` flag that any upward intent
// clears keeps a reader who scrolled away perfectly still.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const EDGE_THRESHOLD = 48;
// Gap from the viewport top to a freshly-sent user turn when it's seated. Small
// on purpose: the new message should sit right at the top, not several lines
// down (just enough breathing room from the header).
const CONTEXT_GAP = 16;

export interface ChatScroll {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: (node: HTMLDivElement | null) => void;
  spacerHeight: number;
  atBottom: boolean;
  scrollToLatest: () => void;
  onUserSend: () => void;
}

export function useChatScroll(
  streaming: boolean,
  revision: unknown,
): ChatScroll {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentElRef = useRef<HTMLDivElement | null>(null);
  const contentRoRef = useRef<ResizeObserver | null>(null);
  const followingRef = useRef(true);
  // Auto-follow is a streaming concept. A content resize while at rest (expanding
  // an agent-steps block, an image loading) must NOT yank the reader to the
  // bottom — only a live, streaming edge does.
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  // The scrollTop of our last programmatic scroll. A scroll event landing at
  // (≈) this position is ours; one landing elsewhere is the reader moving. This
  // beats a time-window guard: during streaming we scroll every token, so a
  // window is always "open" and would swallow every genuine reader scroll.
  const programmaticTopRef = useRef(-1);
  const [atBottom, setAtBottom] = useState(true);
  const [spacerHeight, setSpacerHeight] = useState(0);

  // Distance from the current scroll position to the very bottom (content +
  // spacer). >0 → there is content/reserve below the fold.
  const bottomDelta = useCallback((): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  // Recompute "am I at the bottom?" purely from position. Driven from EVERY
  // signal that can change it — scrolls, content growth/shrink, spacer resize —
  // not just scroll events. This is what keeps the jump-to-latest button honest:
  // if content settles below the fold (or you scroll up), it reappears; if the
  // view is genuinely at the bottom, it hides. A scroll-event-only model could
  // leave it stuck hidden after a programmatic jump + layout change.
  const updateAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_THRESHOLD);
  }, []);

  const setScrollTop = useCallback((top: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const next = Math.max(0, top);
    programmaticTopRef.current = next;
    el.scrollTop = next;
  }, []);

  // Follow: only ever scroll DOWN, to the scrollHeight bottom.
  const followLiveEdge = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const d = bottomDelta();
    if (d > 1) setScrollTop(el.scrollTop + d);
  }, [bottomDelta, setScrollTop]);

  // Size the trailing spacer. Two regimes:
  //
  //  • The whole transcript FITS on screen → spacer just fills the remainder so
  //    content + spacer == viewport exactly. Nothing overflows, so the view is
  //    NOT scrollable — a short chat sits static on one screen, no dead space
  //    to scroll through.
  //  • The transcript OVERFLOWS → reserve viewport − currentTurnHeight − gap so
  //    the newest turn seats near the top and its answer eats the space as it
  //    grows; older turns scroll above the fold.
  //
  // The switch is by total content height, so we never manufacture scrollable
  // emptiness for a conversation that already fits.
  const recomputeSpacer = useCallback(() => {
    const el = scrollRef.current;
    const content = contentElRef.current;
    if (!el || !content) return;
    const viewport = el.clientHeight;
    const rect = content.getBoundingClientRect();
    const totalContent = rect.height;

    let next: number;
    const users = content.querySelectorAll<HTMLElement>("[data-user-msg]");
    const lastUser = users[users.length - 1];
    if (totalContent <= viewport || !lastUser) {
      // Fits (or nothing to seat) → fill to exactly one viewport, no scroll.
      next = Math.max(0, viewport - totalContent);
    } else {
      // Overflows → reserve room to seat the newest turn near the top.
      const currentTurnHeight = rect.bottom - lastUser.getBoundingClientRect().top;
      next = Math.max(0, viewport - currentTurnHeight - CONTEXT_GAP);
    }
    setSpacerHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
  }, []);

  // Re-anchor the new turn when streaming starts (reserve space + follow).
  useEffect(() => {
    recomputeSpacer();
    if (followingRef.current) requestAnimationFrame(followLiveEdge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // The transcript grows through React re-renders (one per streamed token
  // batch), and a ResizeObserver on the content proved unreliable at catching
  // that growth here — so drive the recompute+follow straight off the render
  // cycle. A layout effect keyed on the transcript revision runs after every
  // commit and before paint, so the spacer shrinks and the live edge advances
  // in lockstep with the text: no frozen reserve, no end-of-stream jump.
  useLayoutEffect(() => {
    recomputeSpacer();
    if (followingRef.current) followLiveEdge();
    updateAtBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Grow-follow, wired via a CALLBACK REF (not a mount effect): on every content
  // resize, keep the spacer sized and — if following — hold the live edge.
  //
  // Why a callback ref: the transcript node only exists once there are items
  // (the empty state renders instead). A one-shot effect reading contentRef on
  // mount sees `null`, early-returns, and never observes anything — so during
  // streaming nothing recomputes and the spacer/scroll freeze until the run
  // ends. A callback ref binds the observer the instant the node mounts.
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentElRef.current = node;
      contentRoRef.current?.disconnect();
      contentRoRef.current = null;
      if (node) {
        const ro = new ResizeObserver(() => {
          recomputeSpacer();
          if (streamingRef.current && followingRef.current) followLiveEdge();
          updateAtBottom();
        });
        ro.observe(node);
        contentRoRef.current = ro;
      }
    },
    [recomputeSpacer, followLiveEdge, updateAtBottom],
  );

  // Track position; distinguish our programmatic scrolls from the reader's.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const el2 = scrollRef.current;
      if (!el2) return;
      const delta = bottomDelta();
      updateAtBottom();
      // Ignore the scroll we just performed; react only to the reader's.
      if (Math.abs(el2.scrollTop - programmaticTopRef.current) <= 2) return;
      // A reader scroll: follow only while essentially AT the bottom. Being
      // merely NEAR it must not re-arm auto-scroll, or a small scroll-up
      // mid-stream snaps them straight back down (the "can't scroll up" bug).
      followingRef.current = delta < 4;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      recomputeSpacer();
      updateAtBottom();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [bottomDelta, recomputeSpacer, updateAtBottom]);

  // Upward intent from any modality disengages following.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followingRef.current = false;
    };
    const onTouch = () => {
      if (bottomDelta() >= EDGE_THRESHOLD) followingRef.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key))
        followingRef.current = false;
    };
    const onSelect = () => {
      if ((window.getSelection()?.toString().length ?? 0) > 0)
        followingRef.current = false;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouch, { passive: true });
    el.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSelect);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouch);
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", onSelect);
    };
  }, [bottomDelta]);

  const scrollToLatest = useCallback(() => {
    followingRef.current = true;
    setAtBottom(true);
    requestAnimationFrame(() => {
      followLiveEdge();
      // Reconcile against reality — if the jump couldn't reach the bottom, the
      // button stays visible rather than hiding on a false "at bottom".
      requestAnimationFrame(updateAtBottom);
    });
  }, [followLiveEdge, updateAtBottom]);

  const onUserSend = useCallback(() => {
    followingRef.current = true;
    // Size the reserve, then anchor the new turn (scroll to scrollHeight bottom).
    requestAnimationFrame(() => {
      recomputeSpacer();
      requestAnimationFrame(followLiveEdge);
    });
  }, [recomputeSpacer, followLiveEdge]);

  return {
    scrollRef,
    contentRef,
    spacerHeight,
    atBottom,
    scrollToLatest,
    onUserSend,
  };
}
