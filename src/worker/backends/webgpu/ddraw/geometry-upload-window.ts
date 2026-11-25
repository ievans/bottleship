/** Diagnostic census: real queue.writeBuffer calls issued across every window instance.
 *  Read via the `flushCensus` harness command — the sanctioned way to check whether
 *  staging is actually coalescing many draws into one submit, per CLAUDE.md's
 *  "thousands of small D3D draws become one queue.writeBuffer range per ring" design. */
export const flushCensus = { calls: 0, bytes: 0 };

/** CPU staging for one monotonically allocated GPU ring between queue submissions. */
export class GeometryUploadWindow {
    private bytes = new Uint8Array(0);
    private dirtyOffset = 0;

    stage(gpuOffset: number, data: Uint8Array): void {
        const localOffset = gpuOffset - this.dirtyOffset;
        const required = localOffset + data.byteLength;
        if (required > this.bytes.byteLength) {
            let capacity = Math.max(4096, this.bytes.byteLength || 0);
            while (capacity < required) capacity *= 2;
            const grown = new Uint8Array(capacity);
            grown.set(this.bytes);
            this.bytes = grown;
        }
        this.bytes.set(data, localOffset);
    }

    flush(queue: GPUQueue, buffer: GPUBuffer, endOffset: number): void {
        if (endOffset <= this.dirtyOffset) return;
        const len = endOffset - this.dirtyOffset;
        queue.writeBuffer(buffer, this.dirtyOffset, this.bytes.buffer, 0, len);
        flushCensus.calls++;
        flushCensus.bytes += len;
        this.dirtyOffset = endOffset;
    }

    /** Advance past bytes produced by a GPU copy, which must not be overwritten by staging. */
    advanceTo(offset: number): void {
        this.dirtyOffset = offset;
    }

    reset(): void {
        this.dirtyOffset = 0;
    }
}
