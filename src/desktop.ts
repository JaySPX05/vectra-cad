/** The desktop (Electron) bridge from electron/preload.cjs; null when running in a browser. */
export interface DrawingFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface DesktopBridge {
  isDesktop: true;
  initialFile(): Promise<DrawingFile | null>;
  openFile(): Promise<DrawingFile | null>;
  saveFile(path: string, data: Uint8Array): Promise<{ path: string; name: string }>;
  saveFileAs(suggestedPath: string, data: Uint8Array): Promise<{ path: string; name: string } | null>;
  pathForFile(file: File): string;
  setDocState(dirty: boolean, title: string): void;
  closeConfirmed(): void;
  onFileOpened(cb: (f: DrawingFile) => void): void;
  onMenu(cb: (name: string) => void): void;
}

export const desktop: DesktopBridge | null = (window as unknown as { vectra?: DesktopBridge }).vectra ?? null;
