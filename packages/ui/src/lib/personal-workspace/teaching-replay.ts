/** Runs inside CarterBot's unprivileged, cookie-isolated guest. Its file server
 * omits MIME headers. Explicit source type plays without moving any tokens. */
export function teachingReplayScript(videoUrl: string) {
  const url = new URL(videoUrl);
  if (!/^\/files\/recordings\/[a-zA-Z0-9-]+\/screen\.mp4$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('teaching_invalid_video');
  return `(() => { const url = ${JSON.stringify(url.href)}; if (location.origin !== new URL(url).origin || document.readyState === 'loading') return false; const player = document.createElement('video'); player.controls = true; player.playsInline = true; player.style.cssText = 'width:100%;height:100%;object-fit:contain'; const source = document.createElement('source'); source.src = url; source.type = 'video/mp4'; player.append(source); const body = document.createElement('body'); body.style.cssText = 'margin:0;height:100vh;background:black'; body.append(player); document.body.replaceWith(body); return true; })()`;
}
