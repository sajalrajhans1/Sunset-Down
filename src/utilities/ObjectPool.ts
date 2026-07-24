/**
 * Generic object pool. Every transient game entity (bullets, particles, decals,
 * damage numbers, zombies) is pooled so the GC never runs mid-firefight.
 */
export class ObjectPool<T> {
  private readonly free: T[] = [];
  private readonly liveSet = new Set<T>();
  private readonly factory: () => T;
  private readonly onAcquire?: (item: T) => void;
  private readonly onRelease?: (item: T) => void;
  private readonly maxSize: number;

  constructor(options: {
    factory: () => T;
    initialSize?: number;
    maxSize?: number;
    onAcquire?: (item: T) => void;
    onRelease?: (item: T) => void;
  }) {
    this.factory = options.factory;
    this.onAcquire = options.onAcquire;
    this.onRelease = options.onRelease;
    this.maxSize = options.maxSize ?? 4096;
    const initial = options.initialSize ?? 0;
    for (let i = 0; i < initial; i++) this.free.push(this.factory());
  }

  get liveCount(): number {
    return this.liveSet.size;
  }

  get freeCount(): number {
    return this.free.length;
  }

  /** Returns null when the hard cap is reached rather than growing unbounded. */
  acquire(): T | null {
    let item = this.free.pop();
    if (!item) {
      if (this.liveSet.size >= this.maxSize) return null;
      item = this.factory();
    }
    this.liveSet.add(item);
    this.onAcquire?.(item);
    return item;
  }

  release(item: T): void {
    if (!this.liveSet.delete(item)) return;
    this.onRelease?.(item);
    this.free.push(item);
  }

  /** Iterate live items safely even if the callback releases some of them. */
  forEachLive(fn: (item: T) => void): void {
    for (const item of Array.from(this.liveSet)) fn(item);
  }

  releaseAll(): void {
    for (const item of Array.from(this.liveSet)) this.release(item);
  }

  /** Drops pooled references so the caller can dispose GPU resources. */
  drain(): T[] {
    const all = [...this.liveSet, ...this.free];
    this.liveSet.clear();
    this.free.length = 0;
    return all;
  }
}
