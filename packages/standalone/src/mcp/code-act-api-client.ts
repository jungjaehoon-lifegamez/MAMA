import http from 'node:http';

import { CodeActPostSendTransportError } from './code-act-terminal-transport.js';

export interface CodeActApiResponse {
  success: boolean;
  value?: unknown;
  logs?: string[];
  error?: string;
  terminalCode?: string;
  retryable?: boolean;
  abort?: boolean;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

export function callCodeActAPI(
  body: Record<string, unknown>,
  options: { port: number; authToken?: string; timeoutMs: number }
): Promise<CodeActApiResponse> {
  return new Promise((resolve, reject) => {
    const serialized = JSON.stringify(body);
    let bodyTransmitted = false;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };
    const transportFailure = (message: string) =>
      bodyTransmitted ? new CodeActPostSendTransportError(message) : new Error(message);
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serialized),
    };
    if (options.authToken) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: '/api/code-act',
        method: 'POST',
        headers,
        timeout: options.timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('aborted', () =>
          finish(() => reject(new CodeActPostSendTransportError('Code-Act API response aborted')))
        );
        res.on('error', (error) =>
          finish(() =>
            reject(
              new CodeActPostSendTransportError(`Code-Act API response failed: ${error.message}`)
            )
          )
        );
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const statusCode = res.statusCode ?? 0;
            if (statusCode >= 400 && statusCode < 500) {
              const error =
                typeof parsed.message === 'string'
                  ? parsed.message
                  : typeof parsed.error === 'string'
                    ? parsed.error
                    : `Code-Act API rejected the request (HTTP ${statusCode})`;
              finish(() => resolve({ success: false, error }));
              return;
            }
            if (statusCode !== 200 || typeof parsed.success !== 'boolean') {
              finish(() =>
                reject(
                  new CodeActPostSendTransportError(
                    `Ambiguous Code-Act API response (HTTP ${statusCode})`
                  )
                )
              );
              return;
            }
            finish(() => resolve(parsed as unknown as CodeActApiResponse));
          } catch {
            finish(() =>
              reject(
                new CodeActPostSendTransportError(
                  `Invalid JSON response (HTTP ${res.statusCode}): ${data.substring(0, 200)}`
                )
              )
            );
          }
        });
      }
    );
    req.once('finish', () => {
      bodyTransmitted = true;
    });
    req.on('error', (error) =>
      finish(() => reject(transportFailure(`Code-Act API connection failed: ${error.message}`)))
    );
    req.on('timeout', () => {
      const error = transportFailure('Code-Act API timeout');
      req.destroy();
      finish(() => reject(error));
    });
    req.write(serialized);
    req.end();
  });
}
