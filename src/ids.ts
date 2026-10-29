// Document ids. No imports, so validators (shared with clients) can check them too.

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{20}$/;

/** 4 characters derived from the table name, so an id says which table it belongs to. */
function tableTag(table: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < table.length; i++) h = Math.imul(h ^ table.charCodeAt(i), 0x01000193) >>> 0;
  let tag = "";
  for (let i = 0; i < 4; i++, h >>>= 5) tag += ID_ALPHABET[h & 31];
  return tag;
}

/** A new random id: 16 random characters (80 bits), plus the table tag when a table is given. */
export function newId(table?: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(table ? 16 : 20));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b & 31];
  return table ? id + tableTag(table) : id;
}

/** True if `id` is a well-formed id for `table` (no database lookup needed). */
export function isIdForTable(id: unknown, table: string): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && id.endsWith(tableTag(table));
}
