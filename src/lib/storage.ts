export interface StoredOutput {
  name: string;
  size: number;
  updatedAt: number;
}

const rootName = "ffmpeg-catalyst";
const outputDirectory = "outputs";

export function hasOPFSSupport(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

export async function saveOutput(name: string, blob: Blob): Promise<void> {
  const directory = await getOutputDirectory();
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function listOutputs(): Promise<StoredOutput[]> {
  if (!hasOPFSSupport()) {
    return [];
  }

  const directory = await getOutputDirectory();
  const outputs: StoredOutput[] = [];

  for await (const handle of directory.values()) {
    if (!("getFile" in handle)) {
      continue;
    }

    const file = await handle.getFile();
    outputs.push({
      name: file.name,
      size: file.size,
      updatedAt: file.lastModified,
    });
  }

  return outputs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readOutput(name: string): Promise<File> {
  const directory = await getOutputDirectory();
  const fileHandle = await directory.getFileHandle(name);
  return fileHandle.getFile();
}

export async function removeOutput(name: string): Promise<void> {
  const directory = await getOutputDirectory();
  await directory.removeEntry(name);
}

async function getOutputDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage.getDirectory) {
    throw new Error("Origin Private File System is not supported in this browser.");
  }

  const root = await navigator.storage.getDirectory();
  const appRoot = await root.getDirectoryHandle(rootName, { create: true });
  return appRoot.getDirectoryHandle(outputDirectory, { create: true });
}
