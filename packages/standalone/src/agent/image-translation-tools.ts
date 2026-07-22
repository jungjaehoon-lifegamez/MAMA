import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';

declare const __dirname: string;

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_REGIONS = 200;
const MAX_TEXT_CHARS = 2_000;
const MAX_COORDINATE = 100_000;
const MAX_IMAGE_WIDTH = 12_000;
const MAX_IMAGE_HEIGHT = 12_000;
const MAX_IMAGE_PIXELS = 40_000_000;

export interface OcrRegion {
  bbox: number[][];
  text: string;
  conf?: number;
}

export interface ImageTranslation {
  original: string;
  translated: string;
}

export interface OverlayAnnotation {
  bbox: number[][];
  translated: string;
  label?: string;
}

export interface ImageTranslationToolServiceOptions {
  workspaceRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWithinWorkspace(candidate: string, root: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`path must stay under the private MAMA workspace: ${root}`);
  }
}

function resolveInputImage(inputPath: string, root: string): string {
  const resolved = resolve(inputPath);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('image path must be a regular file, not a symlink');
  }
  const real = realpathSync(resolved);
  assertWithinWorkspace(real, root);
  if (!IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) {
    throw new Error(`unsupported image extension: ${extname(real)}`);
  }
  return real;
}

function resolveOutputImage(outputPath: string, root: string): string {
  const resolved = resolve(outputPath);
  const parent = realpathSync(dirname(resolved));
  assertWithinWorkspace(parent, root);
  const output = join(parent, basename(resolved));
  if (!IMAGE_EXTENSIONS.has(extname(output).toLowerCase())) {
    throw new Error(`unsupported output extension: ${extname(output)}`);
  }
  if (existsSync(output)) {
    const stats = lstatSync(output);
    if (stats.isSymbolicLink()) {
      throw new Error('output path must not be a symlink');
    }
    if (!stats.isFile()) {
      throw new Error('output path must be a regular file');
    }
  }
  return output;
}

export function resolveOcrPython(home = homedir()): string {
  if (process.env.MAMA_OCR_PYTHON) {
    return process.env.MAMA_OCR_PYTHON;
  }
  const candidates = [
    join(home, '.mama', 'ocr-env', 'bin', 'python3'),
    join(home, '.kagemusha', 'ocr-env', 'bin', 'python3'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const stats = lstatSync(candidate);
      if (stats.isFile() || stats.isSymbolicLink()) {
        // Do not realpath a virtualenv interpreter. Python uses the invoked
        // venv path to discover pyvenv.cfg and its site-packages.
        return candidate;
      }
    }
  }
  return 'python3';
}

function scriptPath(name: 'ocr-image.py' | 'fb-overlay.py'): string {
  const scriptRoot = process.env.MAMA_IMAGE_SCRIPT_DIR || resolve(__dirname, '../../scripts/image');
  return join(scriptRoot, name);
}

function parseOcrRegions(value: unknown): OcrRegion[] {
  if (!Array.isArray(value) || value.length > MAX_REGIONS) {
    throw new Error('OCR runtime returned an invalid response');
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !isBoundedBbox(item.bbox) ||
      typeof item.text !== 'string' ||
      item.text.length > MAX_TEXT_CHARS
    ) {
      throw new Error('OCR runtime returned an invalid region');
    }
    return {
      bbox: item.bbox as number[][],
      text: item.text,
      ...(typeof item.conf === 'number' ? { conf: item.conf } : {}),
    };
  });
}

function isBoundedBbox(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every(
          (coordinate) =>
            typeof coordinate === 'number' &&
            Number.isFinite(coordinate) &&
            coordinate >= 0 &&
            coordinate <= MAX_COORDINATE
        )
    )
  );
}

function validateAnnotations(value: unknown): OverlayAnnotation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REGIONS) {
    throw new Error('annotations must be a non-empty array');
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !isBoundedBbox(item.bbox) ||
      typeof item.translated !== 'string' ||
      item.translated.length === 0 ||
      item.translated.length > MAX_TEXT_CHARS
    ) {
      throw new Error('annotations must contain a bounded bbox and translated text');
    }
    return {
      bbox: item.bbox as number[][],
      translated: item.translated,
      ...(typeof item.label === 'string' ? { label: item.label.slice(0, 200) } : {}),
    };
  });
}

async function inspectImage(path: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(path, { limitInputPixels: false }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw new Error('image dimensions are unavailable');
  }
  if (width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(
      `image dimensions exceed the OCR limit (${width}x${height}; max ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT} and ${MAX_IMAGE_PIXELS} pixels)`
    );
  }
  return { width, height };
}

function assertBboxesWithinImage(
  items: readonly { bbox: number[][] }[],
  dimensions: { width: number; height: number }
): void {
  if (
    items.some((item) => item.bbox.some(([x, y]) => x > dimensions.width || y > dimensions.height))
  ) {
    throw new Error('annotation bbox exceeds image bounds');
  }
}

async function executeJsonScript(
  script: 'ocr-image.py' | 'fb-overlay.py',
  args: string[],
  timeout: number
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(resolveOcrPython(), [scriptPath(script), ...args], {
      timeout,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`image translation runtime failed: ${reason}`);
  }
}

export class ImageTranslationToolService {
  private readonly workspaceRoot: string;

  constructor(options: ImageTranslationToolServiceOptions = {}) {
    this.workspaceRoot = resolve(
      options.workspaceRoot || process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace')
    );
  }

  private canonicalWorkspaceRoot(): string {
    return realpathSync(this.workspaceRoot);
  }

  async ocrImage(input: { path: string; lang?: string }): Promise<{ regions: OcrRegion[] }> {
    if (!input.path) {
      throw new Error('path is required');
    }
    const path = resolveInputImage(input.path, this.canonicalWorkspaceRoot());
    const dimensions = await inspectImage(path);
    const result = await executeJsonScript(
      'ocr-image.py',
      [path, '--lang', input.lang ?? 'ja,en'],
      90_000
    );
    const regions = parseOcrRegions(result);
    assertBboxesWithinImage(regions, dimensions);
    return { regions };
  }

  async createOverlay(input: {
    imagePath: string;
    annotations: unknown;
    outputPath?: string;
  }): Promise<{ outputPath: string }> {
    if (!input.imagePath) {
      throw new Error('imagePath is required');
    }
    const workspaceRoot = this.canonicalWorkspaceRoot();
    const imagePath = resolveInputImage(input.imagePath, workspaceRoot);
    const annotations = validateAnnotations(input.annotations);
    const outputPath = resolveOutputImage(
      input.outputPath ||
        join(dirname(imagePath), basename(imagePath, extname(imagePath)) + '_KR.png'),
      workspaceRoot
    );
    const dimensions = await inspectImage(imagePath);
    assertBboxesWithinImage(annotations, dimensions);
    const scratchDir = join(workspaceRoot, 'media', 'outbound', '.annotations');
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const annotationsPath = join(scratchDir, `${randomUUID()}.json`);
    writeFileSync(annotationsPath, JSON.stringify(annotations), { mode: 0o600 });
    try {
      const result = await executeJsonScript(
        'fb-overlay.py',
        [imagePath, annotationsPath, outputPath],
        60_000
      );
      const record = isRecord(result) ? result : {};
      return {
        outputPath:
          typeof record.outputPath === 'string'
            ? resolveOutputImage(record.outputPath, workspaceRoot)
            : outputPath,
      };
    } finally {
      try {
        unlinkSync(annotationsPath);
      } catch {
        // Best-effort cleanup of a private scratch file.
      }
    }
  }

  async translateConti(input: {
    imagePath: string;
    ocrResults?: OcrRegion[];
    translations?: ImageTranslation[];
    outputPath?: string;
  }): Promise<Record<string, unknown>> {
    const imagePath = resolveInputImage(input.imagePath, this.canonicalWorkspaceRoot());
    const ocrResults = input.ocrResults
      ? parseOcrRegions(input.ocrResults)
      : (await this.ocrImage({ path: imagePath })).regions;
    if (!input.translations) {
      return {
        needsTranslation: true,
        ocrResults,
        message: 'OCR complete. Translate each region and call translate_conti again.',
      };
    }
    if (input.translations.length > MAX_REGIONS) {
      throw new Error('translations exceed the region limit');
    }
    const usedRegionIndexes = new Set<number>();
    const annotations = input.translations.flatMap((translation) => {
      if (
        typeof translation.original !== 'string' ||
        typeof translation.translated !== 'string' ||
        translation.original.length > MAX_TEXT_CHARS ||
        translation.translated.length > MAX_TEXT_CHARS
      ) {
        throw new Error('translations contain invalid text');
      }
      const matchIndex = ocrResults.findIndex(
        (region, index) =>
          !usedRegionIndexes.has(index) &&
          (region.text.includes(translation.original) || translation.original.includes(region.text))
      );
      const match = matchIndex >= 0 ? ocrResults[matchIndex] : undefined;
      if (match) usedRegionIndexes.add(matchIndex);
      return match ? [{ bbox: match.bbox, translated: translation.translated, label: '' }] : [];
    });
    if (annotations.length === 0) {
      throw new Error('No translations matched the OCR regions');
    }
    const overlay = await this.createOverlay({
      imagePath,
      annotations,
      outputPath: input.outputPath,
    });
    return { ...overlay, translatedCount: annotations.length };
  }

  driveTranslateConti(input: { drivePath: string }): { workflow: string[] } {
    if (!input.drivePath?.trim()) {
      throw new Error('drivePath is required');
    }
    return {
      workflow: [
        'Resolve the destination with drive_find_folder.',
        'List source images with drive_browse.',
        'Download each image with drive_download.',
        'Run translate_conti twice: OCR, then translated overlay.',
        'Upload each generated _KR image with drive_upload to the resolved destination.',
        'Send generated images to the current Telegram chat with telegram_send.',
      ],
    };
  }
}
