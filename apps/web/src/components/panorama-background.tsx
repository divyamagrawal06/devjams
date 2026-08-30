"use client";

/**
 * The supplied artwork is one panorama face, so it is presented as a slow
 * environmental pan rather than stretched into an incorrect cube skybox.
 */
export function PanoramaBackground() {
  return <div aria-hidden="true" className="panorama-canvas" />;
}
