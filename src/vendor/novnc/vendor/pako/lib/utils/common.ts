type TypedBuffer = Uint8Array | Uint16Array | Int32Array;
type BufferLike = TypedBuffer | number[];

// reduce buffer size, avoiding mem copy
export function shrinkBuf<T extends BufferLike> (buf: T, size: number): T {
  if (buf.length === size) { return buf; }
  if ("subarray" in buf) { return buf.subarray(0, size) as T; }
  buf.length = size;
  return buf;
};


export function arraySet (dest: BufferLike, src: BufferLike, src_offs: number, len: number, dest_offs: number): void {
  if ("subarray" in src && "set" in dest) {
    dest.set(src.subarray(src_offs, src_offs + len), dest_offs);
    return;
  }
  // Fallback to ordinary array
  for (var i = 0; i < len; i++) {
    dest[dest_offs + i] = src[src_offs + i];
  }
}

// Join array of chunks to single array.
export function flattenChunks (chunks: Uint8Array[]): Uint8Array {
  var i, l, len, pos, chunk, result;

  // calculate data length
  len = 0;
  for (i = 0, l = chunks.length; i < l; i++) {
    len += chunks[i].length;
  }

  // join chunks
  result = new Uint8Array(len);
  pos = 0;
  for (i = 0, l = chunks.length; i < l; i++) {
    chunk = chunks[i];
    result.set(chunk, pos);
    pos += chunk.length;
  }

  return result;
}

export var Buf8  = Uint8Array;
export var Buf16 = Uint16Array;
export var Buf32 = Int32Array;
