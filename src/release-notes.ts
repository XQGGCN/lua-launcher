/** Release notes are Markdown; the dialog shows them as plain text. */
export function plainNotes(notes: string): string {
  return notes
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^(\s*)- /gm, '$1· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
