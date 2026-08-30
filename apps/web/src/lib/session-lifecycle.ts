export const SESSION_INVALIDATED_EVENT = "indexd:session-invalidated";
const INDEXD_SESSION_PREFIX = "indexd:";

export function sessionTransitionRequiresPurge(
  previousUserId: string | null | undefined,
  nextUserId: string | null,
  pending: boolean,
): boolean {
  if (pending || previousUserId === undefined) return false;
  return previousUserId !== null && previousUserId !== nextUserId;
}

export function purgeIndexdSessionStorage(storage: Pick<Storage, "key" | "length" | "removeItem">) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(INDEXD_SESSION_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
  return keys;
}
