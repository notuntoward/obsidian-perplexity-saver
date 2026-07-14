import { App, TFile, normalizePath } from "obsidian";
import { sanitizeFilename } from "./utils";

interface CreateNoteParams {
  app: App;
  activeFile: TFile;
  clipboardContent: string;
  filename: string;
  searchesFolder: string;
  generatedTag: string;
}

interface CreateNoteSuccess {
  success: true;
  newFile: TFile;
  newNotePath: string;
  linkText: string;
}

interface CreateNoteError {
  success: false;
  error: string;
}

export type CreateNoteResult = CreateNoteSuccess | CreateNoteError;

export async function createPerplexityNote(
  params: CreateNoteParams
): Promise<CreateNoteResult> {
  const { app, activeFile, clipboardContent, filename, searchesFolder, generatedTag } = params;

  const sanitized = sanitizeFilename(filename);
  if (!sanitized) {
    return { success: false, error: "Filename is empty or contains only invalid characters." };
  }

  const activeFolderPath = activeFile.parent ? activeFile.parent.path : "";
  const folderPath = normalizePath(
    activeFolderPath ? `${activeFolderPath}/${searchesFolder}` : searchesFolder
  );

  const folderExists = app.vault.getAbstractFileByPath(folderPath);
  if (!folderExists) {
    await app.vault.createFolder(folderPath);
  }

  const newNotePath = normalizePath(`${folderPath}/${sanitized}.md`);

  const existingFile = app.vault.getAbstractFileByPath(newNotePath);
  if (existingFile) {
    return { success: false, error: "A note with that name already exists. Pick a different name." };
  }

  const newFile = await app.vault.create(newNotePath, clipboardContent);

  await app.fileManager.processFrontMatter(newFile, (fm: Record<string, unknown>) => {
    const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
    if (!tags.includes(generatedTag)) {
      tags.push(generatedTag);
    }
    fm.tags = tags;
  });

  await navigator.clipboard.writeText("");

  const linkText = app.fileManager.generateMarkdownLink(newFile, activeFile.path);

  return { success: true, newFile, newNotePath, linkText };
}
