declare module 'pngjs' {
  export const PNG: { sync: { read(bytes: Buffer, options?: { checkCRC?: boolean }): { width: number; height: number; data: Buffer; depth: number; gamma?: number }; write(image: { width: number; height: number; data: Buffer }, options?: { colorType?: number; bitDepth?: number; inputHasAlpha?: boolean }): Buffer } };
}
