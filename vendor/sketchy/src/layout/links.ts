export const EDITORS = ["vscode", "cursor", "windsurf", "vscode-insiders", "zed"] as const;

export type Editor = (typeof EDITORS)[number];

export function parseEditor(value: string | undefined): Editor {
  return (EDITORS as readonly string[]).includes(value ?? "") ? (value as Editor) : "vscode";
}

/** Deep link that opens a file (and line) in a desktop editor. */
export function editorLink(
  file: string,
  line: number | undefined,
  editor: Editor = "vscode",
): string {
  const path = file.replace(/\\/g, "/");
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const encoded = absolute
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `${editor}://file${encoded}${line ? `:${line}` : ""}`;
}
