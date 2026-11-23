const objectUrls = new Set<string>();

export function createPrivateObjectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

export function revokePrivateObjectUrl(url: string): void {
  if (!objectUrls.delete(url)) return;
  URL.revokeObjectURL(url);
}

export function clearPrivateObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

export function privateObjectUrlCount(): number {
  return objectUrls.size;
}
