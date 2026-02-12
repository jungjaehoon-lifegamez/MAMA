/**
 * Upload/Download handler for webchat media
 *
 * - POST /api/upload   — multipart file upload (images)
 * - GET  /api/media/:filename — serve uploaded/generated files
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';

const MEDIA_BASE = path.join(homedir(), '.mama', 'workspace', 'media');
const INBOUND_DIR = path.join(MEDIA_BASE, 'inbound');
const OUTBOUND_DIR = path.join(MEDIA_BASE, 'outbound');
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB raw limit
const COMPRESS_THRESHOLD = 500 * 1024; // 500KB → compress for Claude vision

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
]);

// Ensure directories exist
for (const dir of [INBOUND_DIR, OUTBOUND_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, INBOUND_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

// Map extension to expected MIME type for validation
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    // Validate extension matches MIME type to prevent spoofing
    const ext = path.extname(file.originalname).toLowerCase();
    const expectedMime = EXT_TO_MIME[ext];
    if (expectedMime && expectedMime !== file.mimetype) {
      cb(new Error(`Extension ${ext} does not match MIME type ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

/**
 * Compress image if over threshold using sharp
 */
async function compressIfNeeded(filePath: string, size: number): Promise<string> {
  if (size <= COMPRESS_THRESHOLD) return filePath;

  try {
    const sharp = (await import('sharp')).default;
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return filePath;

    const compressedPath = filePath.replace(/(\.[^.]+)$/, '_compressed$1');
    let pipeline = sharp(filePath).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true });

    if (ext === '.png') {
      pipeline = pipeline.png({ quality: 80 });
    } else {
      pipeline = pipeline.jpeg({ quality: 80 });
    }

    await pipeline.toFile(compressedPath);

    // Replace original with compressed (atomic-ish swap)
    try {
      fs.unlinkSync(filePath);
      fs.renameSync(compressedPath, filePath);
    } catch (swapErr) {
      console.warn(`[Upload] Failed to swap compressed file, keeping original:`, swapErr);
      // Clean up compressed file if rename failed
      try {
        fs.unlinkSync(compressedPath);
      } catch {
        /* ignore */
      }
      return filePath;
    }

    const newSize = fs.statSync(filePath).size;
    console.log(`[Upload] Compressed ${path.basename(filePath)}: ${size} → ${newSize} bytes`);
    return filePath;
  } catch (err) {
    console.warn(`[Upload] sharp not available, skipping compression:`, err);
    return filePath;
  }
}

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function findMediaFile(safeName: string): string | null {
  for (const dir of [OUTBOUND_DIR, INBOUND_DIR]) {
    const fullPath = path.join(dir, safeName);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

// Simple in-memory rate limiter for uploads
const uploadRateLimit = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 uploads per minute

// Periodically clean up stale rate-limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of uploadRateLimit) {
    const active = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
    if (active.length === 0) {
      uploadRateLimit.delete(ip);
    } else {
      uploadRateLimit.set(ip, active);
    }
  }
}, 5 * 60_000).unref(); // unref() prevents this timer from keeping the process alive

function checkUploadRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = (uploadRateLimit.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  uploadRateLimit.set(ip, timestamps);
  return true;
}

export function createUploadRouter(): Router {
  const router = Router();

  // POST /api/upload
  router.post(
    '/upload',
    (req: Request, res: Response, next) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!checkUploadRateLimit(ip)) {
        res.status(429).json({ error: 'Too many uploads. Try again later.' });
        return;
      }
      next();
    },
    upload.single('file'),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded' });
          return;
        }

        const { filename, path: filePath, size, mimetype } = req.file;

        // Compress large images
        await compressIfNeeded(filePath, size);
        const finalSize = fs.statSync(filePath).size;

        console.log(`[Upload] ${filename} (${finalSize} bytes, ${mimetype})`);

        res.json({
          success: true,
          filename,
          mediaUrl: `/api/media/${filename}`,
          size: finalSize,
          contentType: mimetype,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        console.error('[Upload] Error:', message);
        res.status(500).json({ error: message });
      }
    }
  );

  // Multer error handler - must be registered after upload middleware
  router.use('/upload', (err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MulterError) {
      // Map Multer error codes to HTTP status codes
      const statusMap: Record<string, number> = {
        LIMIT_FILE_SIZE: 413,
        LIMIT_FILE_COUNT: 400,
        LIMIT_FIELD_KEY: 400,
        LIMIT_FIELD_VALUE: 400,
        LIMIT_FIELD_COUNT: 400,
        LIMIT_UNEXPECTED_FILE: 400,
      };
      const status = statusMap[err.code] || 400;
      res.status(status).json({ error: `Upload error: ${err.message}` });
      return;
    }
    // Pass non-Multer errors to default handler
    next(err);
  });

  // GET /api/media/:filename — serve inbound or outbound files
  router.get('/media/:filename', (req: Request<{ filename: string }>, res: Response) => {
    const { filename } = req.params;
    const safeName = path.basename(filename);
    const fullPath = findMediaFile(safeName);

    if (!fullPath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const ext = path.extname(safeName).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    const stat = fs.statSync(fullPath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    // SVG can contain scripts — force download to prevent Stored XSS
    // Check both extension and content type to catch mismatched files
    if (ext === '.svg' || contentType === 'image/svg+xml') {
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    fs.createReadStream(fullPath).pipe(res);
  });

  // GET /api/media/download/:filename — force download
  router.get('/media/download/:filename', (req: Request<{ filename: string }>, res: Response) => {
    const { filename } = req.params;
    const safeName = path.basename(filename);
    const fullPath = findMediaFile(safeName);

    if (!fullPath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(fullPath).pipe(res);
  });

  return router;
}

export { INBOUND_DIR, OUTBOUND_DIR };
