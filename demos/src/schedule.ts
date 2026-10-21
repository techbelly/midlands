// Redraw on animation frames, one draw in flight at a time: requests that
// arrive while a draw is running (a drag, a slider) coalesce into one more
// draw of the latest state, so frames never pile up behind a slow one and
// async GPU work never overlaps itself.
export function frameScheduler(draw: () => void | Promise<void>): () => void {
  let pending = false;
  let running = false;
  const run = async () => {
    pending = false;
    running = true;
    try {
      await draw();
    } finally {
      running = false;
      if (pending) requestAnimationFrame(() => void run());
    }
  };
  return () => {
    if (pending) return;
    pending = true;
    if (!running) requestAnimationFrame(() => void run());
  };
}
