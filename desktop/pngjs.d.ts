/** Narrow declarations for the exact pngjs 7.0.0 sync API used by Lua.
 * Runtime implementation and MIT notice remain the installed package's. */
declare module 'pngjs' {
  export const PNG: {
    sync: {
      read(input: Buffer, options?: { checkCRC?: true }): { width: number; height: number; data: Buffer }
      write(image: { width: number; height: number; data: Buffer }, options?: {
        bitDepth?: 8; colorType?: 6; inputColorType?: 6; inputHasAlpha?: true; filterType?: 0; deflateLevel?: 9
      }): Buffer
    }
  }
}
