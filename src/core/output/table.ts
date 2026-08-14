import { bold, dim, visibleWidth } from "./color.js";

export interface Column<T> {
  header: string;
  /** Value to display. Return undefined/null for an empty cell. */
  value: (row: T) => unknown;
  /** Right-align, for numeric columns. */
  align?: "left" | "right";
}

/**
 * Render rows as an aligned, borderless table.
 *
 * Borderless because the output stays greppable and diffable - a `|` between
 * every field would fight with the shell tools people pipe this into.
 */
export function renderTable<T>(
  rows: T[],
  columns: Column<T>[],
  color = false,
): string {
  const cells = rows.map((row) =>
    columns.map((column) => formatCell(column.value(row), color)),
  );

  const widths = columns.map((column, index) => {
    const headerWidth = visibleWidth(column.header);
    const bodyWidth = cells.reduce(
      (max, row) => Math.max(max, visibleWidth(row[index] ?? "")),
      0,
    );
    return Math.max(headerWidth, bodyWidth);
  });

  const lines: string[] = [];
  lines.push(
    joinRow(
      columns.map((column, index) =>
        pad(
          bold(column.header.toUpperCase(), color),
          widths[index] ?? 0,
          column.align,
        ),
      ),
    ),
  );

  for (const row of cells) {
    lines.push(
      joinRow(
        row.map((cell, index) =>
          pad(cell, widths[index] ?? 0, columns[index]?.align),
        ),
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

function joinRow(cells: string[]): string {
  return cells.join("  ").trimEnd();
}

function pad(
  text: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
  return align === "right" ? padding + text : text + padding;
}

function formatCell(value: unknown, color: boolean): string {
  if (value === null || value === undefined || value === "") {
    return dim("-", color);
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(",") : dim("-", color);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
