/**
 * Local terminal handling for an interactive session.
 *
 * Raw mode is the important part: without it the local shell would line-buffer
 * input and interpret Ctrl-C itself, so the remote side would never see either.
 * Restoring it is equally important - leaving a terminal in raw mode makes the
 * user's shell appear broken after the CLI exits.
 */
export interface TtySession {
  cols: number;
  rows: number;
  /** Restore the terminal. Safe to call more than once. */
  restore: () => void;
}

export interface TtyHandlers {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export function currentSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || DEFAULT_COLS,
    rows: process.stdout.rows || DEFAULT_ROWS,
  };
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Put the terminal in raw mode and stream input to `onInput`.
 *
 * Everything that mutates global terminal state is undone by `restore`, which
 * is registered against process exit as well so an unexpected throw cannot
 * leave the user with an unusable shell.
 */
export function startTty(handlers: TtyHandlers): TtySession {
  const { cols, rows } = currentSize();
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const onData = (chunk: string): void => handlers.onInput(chunk);
  const onResize = (): void => {
    const size = currentSize();
    handlers.onResize(size.cols, size.rows);
  };

  stdin.on("data", onData);
  process.stdout.on("resize", onResize);

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;

    stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
    process.off("exit", restore);
  };

  process.once("exit", restore);

  return { cols, rows, restore };
}
