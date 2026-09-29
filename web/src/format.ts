/** Tags are stored lowercase; capitalize each word for display. */
export function formatTag(tag: string): string {
  return tag.replace(/(^|[\s_-])\p{L}/gu, (c) => c.toUpperCase());
}
