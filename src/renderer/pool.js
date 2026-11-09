// Promise-based wrapper around Web Workers.
export class ComputeWorker {
  constructor(url = 'worker.js') {
    this.w = new Worker(url);
    this.seq = 0;
    this.pending = new Map();
    this.w.onmessage = (e) => {
      const { id, result, error, progress, msg } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress !== undefined) { p.onProgress?.(progress, msg); return; }
      this.pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(result);
    };
    this.w.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker crashed'));
      this.pending.clear();
    };
  }
  run(cmd, args, transfer = [], onProgress) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.w.postMessage({ id, cmd, args }, transfer);
    });
  }
  terminate() { this.w.terminate(); for (const p of this.pending.values()) p.reject(new Error('cancelled')); this.pending.clear(); }
}
