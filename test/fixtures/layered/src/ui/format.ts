export function formatName(name: string): string {
  return name.length > 10 ? name.slice(0, 10) + '…' : name || 'unnamed'
}
