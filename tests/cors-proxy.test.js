import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import express from 'express';
import multer from 'multer';
import corsProxyMiddleware from '../src/middleware/corsProxy.js';

let upstream;
let proxy;
let upstreamUrl;
let proxyUrl;

async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    return server;
}

beforeAll(async () => {
    const target = express();
    target.use(express.json());
    target.get('/v1/models', (req, res) => res.json({ authorization: req.get('authorization'), data: [{ id: 'qwen3-asr' }] }));
    target.post('/v1/audio/transcriptions', multer().single('file'), (req, res) => res.json({
        text: 'transcribed',
        file: [...req.file.buffer],
        filename: req.file.originalname,
        model: req.body.model,
        language: req.body.language,
        authorization: req.get('authorization'),
        cookie: req.get('cookie') ?? null,
    }));
    target.post('/json', (req, res) => res.json(req.body));
    upstream = await listen(target);
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/proxy/:url(*)', corsProxyMiddleware);
    proxy = await listen(app);
    proxyUrl = `http://127.0.0.1:${proxy.address().port}/proxy/${upstreamUrl}`;
});

afterAll(async () => {
    await Promise.all([proxy, upstream].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
});

describe('CORS proxy', () => {
    test('forwards multipart audio bytes, fields, and authorization without cookies', async () => {
        const audio = new Uint8Array([0, 255, 128, 13, 10, 1]);
        const form = new FormData();
        form.append('file', new Blob([audio], { type: 'audio/wav' }), 'record.wav');
        form.append('model', 'qwen3-asr');
        form.append('language', 'en');
        const response = await fetch(`${proxyUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { Authorization: 'Bearer test-key', Cookie: 'session=private' },
            body: form,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            text: 'transcribed', file: [...audio], filename: 'record.wav',
            model: 'qwen3-asr', language: 'en', authorization: 'Bearer test-key', cookie: null,
        });
    });

    test('forwards model discovery requests', async () => {
        const response = await fetch(`${proxyUrl}/v1/models`, { headers: { Authorization: 'Bearer test-key' } });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ authorization: 'Bearer test-key', data: [{ id: 'qwen3-asr' }] });
    });

    test('continues forwarding parsed JSON bodies', async () => {
        const body = JSON.stringify({ model: 'test' });
        const response = await fetch(`${proxyUrl}/json`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ model: 'test' });
    });
});
