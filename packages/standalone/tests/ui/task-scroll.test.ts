import { scrollTaskHashIntoView } from '../../ui/src/lib/task-scroll';

describe('scrollTaskHashIntoView', () => {
  it('scrolls a task hash only once after the target becomes available', () => {
    const scrollIntoView = vi.fn();
    const findTarget = vi
      .fn<(id: string) => { scrollIntoView: (options: ScrollIntoViewOptions) => void } | null>()
      .mockReturnValueOnce(null)
      .mockReturnValue({ scrollIntoView });

    let scrolledHash: string | null = null;
    scrolledHash = scrollTaskHashIntoView('#task-7', scrolledHash, findTarget);
    scrolledHash = scrollTaskHashIntoView('#task-7', scrolledHash, findTarget);
    scrolledHash = scrollTaskHashIntoView('#task-7', scrolledHash, findTarget);

    expect(scrolledHash).toBe('#task-7');
    expect(findTarget).toHaveBeenCalledTimes(2);
    expect(findTarget).toHaveBeenCalledWith('task-7');
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });
});
