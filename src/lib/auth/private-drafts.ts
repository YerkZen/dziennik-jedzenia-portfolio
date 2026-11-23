interface DraftRecord {
  ownerId: string;
  value: unknown;
}

const drafts = new Map<string, DraftRecord>();

export function savePrivateDraft<T>(key: string, ownerId: string, value: T): void {
  drafts.set(key, { ownerId, value });
}

export function readPrivateDraft<T>(key: string, ownerId: string): T | undefined {
  const record = drafts.get(key);
  return record?.ownerId === ownerId ? (record.value as T) : undefined;
}

export function clearPrivateDrafts(ownerId?: string): void {
  if (ownerId === undefined) {
    drafts.clear();
    return;
  }
  for (const [key, record] of drafts) {
    if (record.ownerId !== ownerId) drafts.delete(key);
  }
}

export function discardPrivateDraft(key: string): void {
  drafts.delete(key);
}

export function hasPrivateDrafts(): boolean {
  return drafts.size > 0;
}
