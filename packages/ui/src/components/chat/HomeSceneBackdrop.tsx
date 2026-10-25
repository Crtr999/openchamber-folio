import React from 'react';
import { useHomeScene } from './homeScenes';

/**
 * The window-wide scene layer behind the desktop shell. It is one static
 * image: full strength while Home is showing (see `useHomeSceneActive`) and a
 * dimmed tint elsewhere, seen through the frosted sidebar, header and rail.
 * Styling lives in styles/open-carter-vibe.css.
 */
export const HomeSceneBackdrop: React.FC = () => {
    const scene = useHomeScene();
    return (
        <div className="oc-scene-backdrop" data-scene={scene.id} aria-hidden="true">
            <div className="oc-scene-art">
                <img key={scene.id} src={scene.src} alt="" width={scene.width} height={scene.height} decoding="async" />
            </div>
        </div>
    );
};
