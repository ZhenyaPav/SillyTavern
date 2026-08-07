import { randomUUID } from 'node:crypto';

import express from 'express';
import fetch from 'node-fetch';

import {
    CHAT_COMPLETION_SOURCES,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MAP,
    OPENAI_REASONING_EFFORT_MODELS,
    OPENAI_VERBOSITY_MODELS,
} from '../../constants.js';
import { excludeKeysByYaml, mergeObjectWithYaml } from '../../util.js';
import { addReasoningContentToToolCalls, embedOpenRouterMedia } from '../../prompt-converters.js';
import { readSecret, SECRET_KEYS } from '../secrets.js';

export const router = express.Router();

const RUN_TTL = 24 * 60 * 60 * 1000;
const TERMINAL_TTL = 10 * 60 * 1000;
const COMMIT_LEASE_TTL = 30 * 1000;
const MAX_RUNS_PER_USER = 20;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** @type {Map<string, any>} */
const runs = new Map();

const ownerKey = request => request.user.profile.handle;
const publicRun = run => ({
    id: run.id,
    chatKey: run.chatKey,
    operation: run.operation,
    context: run.context,
    status: run.status,
    commitStatus: run.commitStatus,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    byteLength: run.byteLength,
    error: run.error,
});

function getOwnedRun(request, response) {
    const run = runs.get(String(request.params.id));
    if (!run || run.owner !== ownerKey(request)) {
        response.sendStatus(404);
        return null;
    }
    return run;
}

function finishSubscribers(run) {
    for (const subscriber of run.subscribers) {
        subscriber.end();
    }
    run.subscribers.clear();
}

function pushChunk(run, chunk) {
    const buffer = Buffer.from(chunk);
    if (run.byteLength + buffer.length > MAX_BUFFER_BYTES) {
        throw new Error('Durable run exceeded the 32 MiB stream buffer limit.');
    }
    run.chunks.push(buffer);
    run.byteLength += buffer.length;
    for (const subscriber of run.subscribers) {
        subscriber.write(buffer);
    }
}

function buildCustomRequest(request, generationData, signal) {
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM, generationData.secret_id);
    const headers = {};
    const bodyParams = {
        logprobs: generationData.logprobs,
        top_logprobs: undefined,
    };
    if (bodyParams.logprobs > 0) {
        bodyParams.top_logprobs = bodyParams.logprobs;
        bodyParams.logprobs = true;
    }
    mergeObjectWithYaml(bodyParams, generationData.custom_include_body);
    mergeObjectWithYaml(headers, generationData.custom_include_headers);
    embedOpenRouterMedia(generationData.messages, { audio: true, video: false });
    addReasoningContentToToolCalls(generationData.messages, { copyReasoning: true });
    if (generationData.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: {
                name: generationData.json_schema.name,
                strict: generationData.json_schema.strict ?? true,
                schema: generationData.json_schema.value,
            },
        };
    }
    if (generationData.reasoning_effort) {
        if (OPENAI_REASONING_EFFORT_MODELS.includes(generationData.model)) {
            bodyParams.reasoning_effort = OPENAI_FIXED_REASONING_EFFORT[generationData.model]
                ?? OPENAI_REASONING_EFFORT_MAP[generationData.reasoning_effort]
                ?? generationData.reasoning_effort;
        } else if (/^koboldcpp\/(.+)$/.test(generationData.model)) {
            bodyParams.reasoning_effort = generationData.reasoning_effort;
        }
    }
    if (generationData.verbosity && OPENAI_VERBOSITY_MODELS.test(generationData.model)) {
        bodyParams.verbosity = generationData.verbosity;
    }

    const body = {
        messages: generationData.messages,
        model: generationData.model,
        temperature: generationData.temperature,
        max_tokens: generationData.max_tokens,
        max_completion_tokens: generationData.max_completion_tokens,
        stream: true,
        presence_penalty: generationData.presence_penalty,
        frequency_penalty: generationData.frequency_penalty,
        top_p: generationData.top_p,
        top_k: generationData.top_k,
        stop: generationData.stop,
        logit_bias: generationData.logit_bias,
        seed: generationData.seed,
        n: generationData.n,
        tools: generationData.tools?.length ? generationData.tools : undefined,
        tool_choice: generationData.tools?.length ? generationData.tool_choice : undefined,
        ...bodyParams,
    };
    excludeKeysByYaml(body, generationData.custom_exclude_body);

    const baseUrl = String(generationData.custom_url || '').replace(/\/$/, '');
    return {
        url: `${baseUrl}/chat/completions`,
        options: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                ...headers,
            },
            body: JSON.stringify(body),
            signal,
        },
    };
}

async function executeRun(request, run, generationData) {
    run.status = 'running';
    run.startedAt = Date.now();
    try {
        const upstream = buildCustomRequest(request, generationData, run.controller.signal);
        const response = await fetch(upstream.url, upstream.options);
        run.upstreamStatus = response.status;
        run.contentType = response.headers.get('content-type') || 'text/event-stream; charset=utf-8';
        if (!response.ok) {
            const text = await response.text();
            run.error = text || response.statusText;
            run.status = 'failed';
            run.completedAt = Date.now();
            finishSubscribers(run);
            return;
        }
        for await (const chunk of response.body) {
            pushChunk(run, chunk);
        }
        run.status = 'completed';
        run.completedAt = Date.now();
    } catch (error) {
        run.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
        run.error = error?.message || String(error);
        run.completedAt = Date.now();
    } finally {
        finishSubscribers(run);
    }
}

router.post('/', (request, response) => {
    const generationData = request.body?.generation_data;
    const chatKey = String(request.body?.chat_key || '');
    const operation = String(request.body?.operation || 'normal');
    if (!chatKey || !generationData || generationData.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM || generationData.stream !== true) {
        return response.status(400).send({ error: 'Only streaming Custom chat completions are supported.' });
    }
    if (!['normal', 'swipe'].includes(operation)) {
        return response.status(400).send({ error: 'Unsupported generation operation.' });
    }

    const owner = ownerKey(request);
    const existing = [...runs.values()].find(run => run.owner === owner && run.chatKey === chatKey
        && (['running', 'reserved'].includes(run.status) || (run.status === 'completed' && run.commitStatus !== 'committed')));
    if (existing) {
        return response.status(409).send(publicRun(existing));
    }

    const ownedRuns = [...runs.values()].filter(run => run.owner === owner);
    if (ownedRuns.length >= MAX_RUNS_PER_USER) {
        const evictable = ownedRuns.filter(run => !['running', 'reserved'].includes(run.status)).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (evictable) runs.delete(evictable.id);
        else return response.status(429).send({ error: 'Too many active durable runs.' });
    }

    const run = {
        id: randomUUID(), owner, chatKey, operation,
        context: request.body.context ?? {},
        status: 'reserved', commitStatus: 'pending',
        createdAt: Date.now(), startedAt: null, completedAt: null,
        byteLength: 0, chunks: [], subscribers: new Set(),
        controller: new AbortController(), error: null, lease: null,
    };
    runs.set(run.id, run);
    response.status(202).send(publicRun(run));
    void executeRun(request, run, structuredClone(generationData));
});

router.get('/', (request, response) => {
    const chatKey = String(request.query.chat_key || '');
    const owner = ownerKey(request);
    response.send([...runs.values()].filter(run => run.owner === owner && (!chatKey || run.chatKey === chatKey)).map(publicRun));
});

router.get('/:id', (request, response) => {
    const run = getOwnedRun(request, response);
    if (run) response.send(publicRun(run));
});

router.get('/:id/stream', (request, response) => {
    const run = getOwnedRun(request, response);
    if (!run) return;
    const offset = Math.max(0, Number(request.query.offset) || 0);
    if (offset > run.byteLength) return response.status(416).send({ error: 'Offset exceeds buffered stream length.' });
    if (run.status === 'failed' && run.byteLength === 0) return response.status(502).send({ error: run.error });

    response.status(200);
    response.set({
        'Content-Type': run.contentType || 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Durable-Run-Id': run.id,
        'X-Durable-Run-Offset': String(offset),
    });
    response.flushHeaders();

    let skipped = 0;
    for (const chunk of run.chunks) {
        const end = skipped + chunk.length;
        if (end > offset) response.write(chunk.subarray(Math.max(0, offset - skipped)));
        skipped = end;
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return response.end();

    run.subscribers.add(response);
    response.on('close', () => run.subscribers.delete(response));
});

router.post('/:id/cancel', (request, response) => {
    const run = getOwnedRun(request, response);
    if (!run) return;
    run.controller.abort('Cancelled by user');
    response.send(publicRun(run));
});

router.post('/:id/claim', (request, response) => {
    const run = getOwnedRun(request, response);
    if (!run) return;
    const clientId = String(request.body?.client_id || '');
    const now = Date.now();
    if (!clientId) return response.sendStatus(400);
    if (run.commitStatus === 'committed') return response.status(409).send(publicRun(run));
    if (run.lease && run.lease.expiresAt > now && run.lease.clientId !== clientId) return response.status(409).send(publicRun(run));
    run.lease = { clientId, expiresAt: now + COMMIT_LEASE_TTL };
    run.commitStatus = 'leased';
    response.send({ ...publicRun(run), leaseExpiresAt: run.lease.expiresAt });
});

router.post('/:id/commit', (request, response) => {
    const run = getOwnedRun(request, response);
    if (!run) return;
    const clientId = String(request.body?.client_id || '');
    if (!run.lease || run.lease.clientId !== clientId) return response.sendStatus(409);
    run.commitStatus = 'committed';
    run.lease = null;
    response.send(publicRun(run));
});

const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, run] of runs) {
        const ttl = run.status === 'completed' && run.commitStatus !== 'committed' ? RUN_TTL : TERMINAL_TTL;
        if (!['running', 'reserved'].includes(run.status) && now - (run.completedAt || run.createdAt) > ttl) runs.delete(id);
    }
}, 60 * 1000);
cleanupTimer.unref?.();
