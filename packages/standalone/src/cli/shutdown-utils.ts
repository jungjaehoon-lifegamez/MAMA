interface StoppableLoop {
  stop(): Promise<void>;
}

export async function stopAgentLoops(
  loops: Array<StoppableLoop | null | undefined>
): Promise<void> {
  await Promise.allSettled(
    loops
      .filter((loop): loop is StoppableLoop => Boolean(loop))
      .map(async (loop) => {
        await loop.stop();
      })
  );
}
