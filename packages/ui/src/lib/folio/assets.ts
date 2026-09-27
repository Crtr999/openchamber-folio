import React from 'react';

/**
 * Attachment bytes for showing images inline. Each runtime registers how it reads them: the Mac asks
 * the notebook engine, the iPhone reads its own storage (fetching from the Mac when needed).
 */
type Reader = (asset: string) => Promise<Blob | undefined>;
let reader: Reader | undefined;
const urls = new Map<string, Promise<string | undefined>>();

export function setFolioAssetReader(next: Reader | undefined): void {
  reader = next;
  urls.clear();
}

export const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp|heic|avif|svg)$/i.test(name);

/** An object URL for an image attachment, loaded once and shared by every place that shows it. */
export function folioAssetURL(asset: string): Promise<string | undefined> {
  const cached = urls.get(asset);
  if (cached) return cached;
  const read = reader;
  if (!read) return Promise.resolve(undefined);
  const loading = read(asset).then((blob) => (blob ? URL.createObjectURL(blob) : undefined)).catch(() => undefined);
  urls.set(asset, loading);
  // A failed read may succeed later (the Mac comes online), so it is not cached.
  void loading.then((url) => { if (!url) urls.delete(asset); });
  return loading;
}

export function useFolioAssetURL(asset: string | undefined): string | undefined {
  const [url, setURL] = React.useState<string>();
  React.useEffect(() => {
    let live = true;
    setURL(undefined);
    if (asset) void folioAssetURL(asset).then((next) => { if (live) setURL(next); });
    return () => { live = false; };
  }, [asset]);
  return url;
}
