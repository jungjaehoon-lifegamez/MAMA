/**
 * The Docker image (v1 D1): MAMA runs as the container's main process, so no service manager
 * starts, restarts or updates it. The image sets MAMA_CONTAINER=1; Docker's own commands do those
 * jobs, and the commands that would ask launchd or systemd name them instead.
 */

export function inContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAMA_CONTAINER === '1';
}

export const CONTAINER_START = 'docker compose up -d';
export const CONTAINER_RESTART = 'docker compose restart';

/** Decision 6 of the 1.0 plan: an image install updates by pulling the image, not by npm. */
export const CONTAINER_UPDATE =
  'MAMA runs from a Docker image here; update it by pulling the new image: docker compose pull && docker compose up -d (the volumes keep the data, settings and sign-ins)';

export const CONTAINER_SERVICE = `MAMA runs as this container's main process; Docker starts and stops it: ${CONTAINER_START} starts it, ${CONTAINER_RESTART} restarts it, docker compose down removes the container (the volumes stay)`;
