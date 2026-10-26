declare module 'mux.js' {
  interface Segment { initSegment: Uint8Array; data: Uint8Array }
  class Transmuxer {
    constructor(opts?: { keepOriginalTimestamps?: boolean });
    on(event: 'data', cb: (seg: Segment) => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }
  const muxjs: { mp4: { Transmuxer: typeof Transmuxer } };
  export default muxjs;
}
