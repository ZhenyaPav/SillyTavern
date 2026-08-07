import express from 'express';

export const router = express.Router();

const STALE_AFTER = 90 * 1000;
/** @type {Map<string, Map<string, {lastSeenAt: number, disconnectedAt: number|null}>>} */
const presence = new Map();

const ownerKey = request => request.user.profile.handle;

router.post('/connect', (request, response) => {
    const clientId = String(request.body?.client_id || '');
    if (!clientId) return response.sendStatus(400);
    const owner = ownerKey(request);
    const now = Date.now();
    const clients = presence.get(owner) ?? new Map();
    const previous = [...clients.entries()]
        .filter(([id]) => id !== clientId)
        .reduce((latest, [, client]) => Math.max(latest, client.lastSeenAt), clients.get(clientId)?.lastSeenAt ?? 0);
    const anotherActive = [...clients.entries()].some(([id, client]) => id !== clientId && now - client.lastSeenAt <= STALE_AFTER && client.disconnectedAt === null);
    const oldClient = clients.get(clientId);
    clients.set(clientId, { lastSeenAt: now, disconnectedAt: null });
    presence.set(owner, clients);
    const lastSeenAt = previous || oldClient?.lastSeenAt || null;
    response.send({
        clientId,
        connectedAt: now,
        lastSeenAt,
        absenceMs: anotherActive || !lastSeenAt ? 0 : Math.max(0, now - lastSeenAt),
        wasUserAbsent: !anotherActive && !!lastSeenAt && now - lastSeenAt > STALE_AFTER,
        disconnectWasExplicit: Boolean(oldClient?.disconnectedAt),
    });
});

router.post('/heartbeat', (request, response) => {
    const clientId = String(request.body?.client_id || '');
    const clients = presence.get(ownerKey(request));
    const client = clients?.get(clientId);
    if (!client) return response.sendStatus(404);
    client.lastSeenAt = Date.now();
    client.disconnectedAt = null;
    response.sendStatus(204);
});

router.post('/disconnect', (request, response) => {
    const clientId = String(request.body?.client_id || '');
    const client = presence.get(ownerKey(request))?.get(clientId);
    if (client) {
        client.lastSeenAt = Date.now();
        client.disconnectedAt = client.lastSeenAt;
    }
    response.sendStatus(204);
});

