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

export const CONTAINER_PULL = 'docker compose pull && docker compose up -d';

/** Decision 6 of the 1.0 plan: an image install updates by pulling the image, not by npm. */
export const CONTAINER_UPDATE = `MAMA runs from a Docker image here; update it by pulling the new image: ${CONTAINER_PULL} (the volumes keep the data, settings and sign-ins)`;

export const CONTAINER_SERVICE = `MAMA runs as this container's main process; Docker starts and stops it: ${CONTAINER_START} starts it, ${CONTAINER_RESTART} restarts it, docker compose down removes the container (the volumes stay). mama stop stops the container too.`;

/** A backup is taken from a stopped install (plan decision 5), which ends this container. */
export const CONTAINER_BACKUP =
  'In the image, back up from a stopped MAMA: docker compose stop, then docker compose run --rm mama mama backup, then docker compose up -d';

export const CONTAINER_UNINSTALL =
  'In the image, docker compose down removes MAMA and keeps its volumes; docker compose down -v also deletes the data, settings and sign-ins';
