const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function wrap(code: string, text: string, enabled: boolean): string {
  return enabled ? `${ESC}${code}m${text}${RESET}` : text;
}

export function green(text: string, enabled: boolean): string {
  return wrap("32", text, enabled);
}

export function yellow(text: string, enabled: boolean): string {
  return wrap("33", text, enabled);
}

export function red(text: string, enabled: boolean): string {
  return wrap("31", text, enabled);
}

export function bold(text: string, enabled: boolean): string {
  return wrap("1", text, enabled);
}

export function dim(text: string, enabled: boolean): string {
  return wrap("2", text, enabled);
}

/** Visible width, ignoring SGR sequences so padding stays aligned. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
