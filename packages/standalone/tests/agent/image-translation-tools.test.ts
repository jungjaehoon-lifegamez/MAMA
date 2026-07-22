import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import {
  ImageTranslationToolService,
  resolveOcrPython,
} from '../../src/agent/image-translation-tools.js';

describe('ImageTranslationToolService safety', () => {
  let workspace: string;
  const originalWorkspace = process.env.MAMA_WORKSPACE;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mama-image-tools-'));
    process.env.MAMA_WORKSPACE = workspace;
  });

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.MAMA_WORKSPACE;
    else process.env.MAMA_WORKSPACE = originalWorkspace;
  });

  it('rejects oversized or malformed model-supplied overlay annotations before subprocess work', async () => {
    const imagePath = join(workspace, 'source.png');
    await writeFile(imagePath, 'fixture');
    const service = new ImageTranslationToolService();

    await expect(
      service.createOverlay({
        imagePath,
        annotations: [{ bbox: [[Number.NaN, 0]], translated: 'text' }],
      })
    ).rejects.toThrow('annotations must contain a bounded bbox');
  });

  it('binds image reads and outputs to the workspace supplied at construction', async () => {
    const configuredWorkspace = await mkdtemp(join(tmpdir(), 'mama-configured-image-root-'));
    const oldDefaultWorkspace = await mkdtemp(join(tmpdir(), 'mama-old-image-root-'));
    const configuredImage = join(configuredWorkspace, 'configured.png');
    const oldImage = join(oldDefaultWorkspace, 'old.png');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(configuredImage);
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(oldImage);
    const service = new ImageTranslationToolService({ workspaceRoot: configuredWorkspace });

    await expect(
      service.createOverlay({ imagePath: configuredImage, annotations: 'invalid' })
    ).rejects.toThrow('annotations must be a non-empty array');
    await expect(service.ocrImage({ path: oldImage })).rejects.toThrow(
      'path must stay under the private MAMA workspace'
    );
  });

  it('never follows an existing output symlink outside the private workspace', async () => {
    const imagePath = join(workspace, 'source.png');
    const outsidePath = join(await mkdtemp(join(tmpdir(), 'mama-outside-')), 'outside.png');
    const outputPath = join(workspace, 'translated.png');
    await writeFile(imagePath, 'fixture');
    await writeFile(outsidePath, 'outside');
    await symlink(outsidePath, outputPath);

    await expect(
      new ImageTranslationToolService().createOverlay({
        imagePath,
        annotations: [
          {
            bbox: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
            translated: 'Translation',
          },
        ],
        outputPath,
      })
    ).rejects.toThrow('output path must not be a symlink');
  });

  it('rejects images whose dimensions exceed the bounded OCR surface', async () => {
    const imagePath = join(workspace, 'too-wide.png');
    await sharp({
      create: { width: 12_001, height: 1, channels: 3, background: '#ffffff' },
    })
      .png()
      .toFile(imagePath);

    await expect(new ImageTranslationToolService().ocrImage({ path: imagePath })).rejects.toThrow(
      'image dimensions exceed'
    );
  });

  it('rejects overlay boxes outside the actual image bounds', async () => {
    const imagePath = join(workspace, 'bounded.png');
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    })
      .png()
      .toFile(imagePath);

    await expect(
      new ImageTranslationToolService().createOverlay({
        imagePath,
        annotations: [
          {
            bbox: [
              [0, 0],
              [101, 0],
              [101, 10],
              [0, 10],
            ],
            translated: 'Out of bounds',
          },
        ],
      })
    ).rejects.toThrow('annotation bbox exceeds image bounds');
  });

  it('keeps the virtualenv interpreter path so Python loads that environment', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'mama-ocr-home-'));
    const bin = join(fakeHome, '.kagemusha', 'ocr-env', 'bin');
    await mkdir(bin, { recursive: true });
    await symlink('/usr/bin/python3', join(bin, 'python3'));

    expect(resolveOcrPython(fakeHome)).toBe(join(bin, 'python3'));
  });

  it('maps repeated OCR text to distinct regions in source order', async () => {
    const imagePath = join(workspace, 'repeated.png');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(imagePath);
    const service = new ImageTranslationToolService();
    const createOverlay = vi
      .spyOn(service, 'createOverlay')
      .mockResolvedValue({ outputPath: join(workspace, 'repeated_KR.png') });
    const firstBox = [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ];
    const secondBox = [
      [0, 20],
      [20, 20],
      [20, 30],
      [0, 30],
    ];

    await expect(
      service.translateConti({
        imagePath,
        ocrResults: [
          { bbox: firstBox, text: '同じ' },
          { bbox: secondBox, text: '同じ' },
        ],
        translations: [
          { original: '同じ', translated: 'First' },
          { original: '同じ', translated: 'Second' },
        ],
      })
    ).resolves.toMatchObject({ translatedCount: 2 });

    expect(createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        annotations: [
          expect.objectContaining({ bbox: firstBox, translated: 'First' }),
          expect.objectContaining({ bbox: secondBox, translated: 'Second' }),
        ],
      })
    );
  });
});
