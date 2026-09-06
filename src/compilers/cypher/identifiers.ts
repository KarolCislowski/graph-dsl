export function escapeIdentifier(identifier: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier;
  }

  return `\`${identifier.replaceAll("`", "``")}\``;
}
