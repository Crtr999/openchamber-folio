import React from 'react';
import engravedCoast from '@/assets/home-engraved-coast.webp';
import nightCoast from '@/assets/home-coast.webp';
import cloudSky from '@/assets/home-cloud-sky.webp';
import stippleNight from '@/assets/home-stipple-night.webp';

/**
 * Bundled Home hero scenes. Each is a local asset; HomeDashboard.css treats
 * them per theme (ink inversion, cobalt duotone, dimming) so every scene
 * reads in both the cream and the ink-black palette.
 */
export const HOME_SCENES = [
  { id: 'engraved-coast', labelKey: 'home.scene.engravedCoast', src: engravedCoast, width: 1280, height: 720 },
  { id: 'night-coast', labelKey: 'home.scene.nightCoast', src: nightCoast, width: 2172, height: 724 },
  { id: 'cloud-sky', labelKey: 'home.scene.cloudSky', src: cloudSky, width: 1280, height: 720 },
  { id: 'stipple-night', labelKey: 'home.scene.stippleNight', src: stippleNight, width: 1280, height: 720 },
] as const;

export type HomeScene = (typeof HOME_SCENES)[number];
export type HomeSceneId = HomeScene['id'];

const DEFAULT_SCENE: HomeScene = HOME_SCENES[0];
const STORAGE_KEY = 'openCarter.homeScene';
const CHANGE_EVENT = 'open-carter:home-scene';

const parseScene = (raw: string | null): HomeScene =>
  HOME_SCENES.find((scene) => scene.id === raw) ?? DEFAULT_SCENE;

const readSceneId = (): HomeSceneId => {
  try {
    return parseScene(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return DEFAULT_SCENE.id;
  }
};

const subscribe = (onChange: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
};

/** The chosen scene, shared by the landscape and the greeting's picker. */
export const useHomeScene = (): HomeScene => {
  const id = React.useSyncExternalStore(subscribe, readSceneId, () => DEFAULT_SCENE.id);
  return parseScene(id);
};

/** Moves to the next bundled scene and remembers it on this device. */
export const cycleHomeScene = (current: HomeSceneId) => {
  const index = HOME_SCENES.findIndex((scene) => scene.id === current);
  const next = HOME_SCENES[(index + 1) % HOME_SCENES.length];
  try {
    localStorage.setItem(STORAGE_KEY, next.id);
  } catch {
    // Storage unavailable (private mode): the default scene stays.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
};

let activeHomeViews = 0;

/**
 * Marks Home as showing (`data-oc-home` on <html>) while the caller is
 * mounted, so the shell can let the scene flow through its panels.
 */
export const useHomeSceneActive = () => {
  React.useEffect(() => {
    activeHomeViews += 1;
    document.documentElement.setAttribute('data-oc-home', '');
    return () => {
      activeHomeViews = Math.max(0, activeHomeViews - 1);
      if (activeHomeViews === 0) document.documentElement.removeAttribute('data-oc-home');
    };
  }, []);
};
