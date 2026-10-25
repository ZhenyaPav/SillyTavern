import { describe, test, expect, jest } from '@jest/globals';
import { PromptStore } from '../public/scripts/prompt-store.js';

function storage() {
    const data = new Map();
    return {
        data,
        getItem: jest.fn(async key => structuredClone(data.get(key) ?? null)),
        setItem: jest.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
        removeItem: jest.fn(async key => { data.delete(key); }),
        clear: jest.fn(async () => { data.clear(); }),
    };
}

function setup() {
    const index = storage();
    const records = storage();
    let id = 0;
    const store = new PromptStore(index, records, () => String(++id));
    return { index, records, store };
}

describe('prompt archive', () => {
    test('migrates every legacy prompt, then opens chats without reading bodies', async () => {
        const { index, records, store } = setup();
        const legacy = Array.from({ length: 100 }, (_, mesId) => ({
            mesId, rawPrompt: 'x'.repeat(16384), finalPrompt: 'y'.repeat(16384),
        }));
        await index.setItem('chat', legacy);

        const summaries = await store.load('chat');
        expect(summaries).toHaveLength(100);
        expect(JSON.stringify(summaries).length).toBeLessThan(10000);
        expect(records.setItem).toHaveBeenCalledTimes(100);
        expect(records.getItem).not.toHaveBeenCalled();
        expect(await store.get('chat', summaries[42])).toEqual(legacy[42]);

        records.getItem.mockClear();
        index.getItem.mockClear();
        expect(await store.load('chat')).toEqual(summaries);
        expect(index.getItem).toHaveBeenCalledTimes(1);
        expect(records.getItem).not.toHaveBeenCalled();
    });

    test('writes only new bodies and skips unchanged indexes', async () => {
        const { index, records, store } = setup();
        const first = { mesId: 1, rawPrompt: [{ role: 'user', content: 'Hello' }] };
        const summaries = await store.save('chat', [first]);
        records.setItem.mockClear();
        index.setItem.mockClear();
        await store.save('chat', summaries);
        expect(records.setItem).not.toHaveBeenCalled();
        expect(index.setItem).not.toHaveBeenCalled();

        const next = { mesId: 3, rawPrompt: 'Next prompt' };
        const saved = await store.save('chat', [...summaries, next]);
        expect(records.setItem).toHaveBeenCalledTimes(1);
        expect(await store.get('chat', saved[0])).toEqual(first);
        expect(await store.get('chat', saved[1])).toEqual(next);
    });

    test('preserves edited prompts, moved IDs, and deletions across reloads', async () => {
        const { records, store } = setup();
        const saved = await store.save('chat', [
            { mesId: 1, rawPrompt: 'one' }, { mesId: 3, rawPrompt: 'three' }, { mesId: 5, rawPrompt: 'five' },
        ]);
        const edited = await store.get('chat', saved[0]);
        edited.rawPrompt = 'edited';
        saved[2].mesId = 2;
        await store.save('chat', [edited, saved[2]]);

        const loaded = await store.load('chat');
        expect(await store.get('chat', loaded[0])).toEqual({ mesId: 1, rawPrompt: 'edited' });
        expect(await store.get('chat', loaded[1])).toEqual({ mesId: 2, rawPrompt: 'five' });
        expect(records.data.size).toBe(2);
    });

    test('keeps the original legacy array when migration fails and allows retry', async () => {
        const { index, records, store } = setup();
        const legacy = [{ mesId: 1, rawPrompt: 'one' }, { mesId: 3, rawPrompt: 'three' }];
        await index.setItem('chat', legacy);
        records.setItem.mockImplementationOnce(async (key, value) => {
            records.data.set(key, structuredClone(value));
        }).mockRejectedValueOnce(new Error('quota'));

        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await store.load('chat')).toEqual(legacy);
        warning.mockRestore();
        expect(await index.getItem('chat')).toEqual(legacy);
        expect(records.data.size).toBe(0);
        expect(await store.load('chat')).toHaveLength(2);
    });

    test('a failed index commit preserves the previously saved body', async () => {
        const { index, records, store } = setup();
        const saved = await store.save('chat', [{ mesId: 1, rawPrompt: 'original' }]);
        index.setItem.mockRejectedValueOnce(new Error('quota'));
        await expect(store.save('chat', [{ mesId: 1, rawPrompt: 'replacement' }])).rejects.toThrow('quota');
        expect(await store.load('chat')).toEqual(saved);
        expect(await store.get('chat', saved[0])).toEqual({ mesId: 1, rawPrompt: 'original' });
        expect(records.data.size).toBe(1);
    });

    test('snapshots message IDs before an asynchronous save', async () => {
        const { store } = setup();
        const prompt = { mesId: 1, rawPrompt: 'original' };
        const saving = store.save('chat', [prompt]);
        prompt.mesId = 9;
        const saved = await saving;
        expect(saved[0].mesId).toBe(1);
        expect((await store.get('chat', saved[0])).mesId).toBe(1);
    });

    test('isolates chats even when their IDs contain separators', async () => {
        const { store } = setup();
        const a = await store.save('a/1', [{ mesId: 1, rawPrompt: 'a' }]);
        const b = await store.save('a', [{ mesId: 1, rawPrompt: 'b' }]);
        await store.delete('a/1');
        expect(await store.load('a/1')).toEqual([]);
        expect(await store.get('a/1', a[0])).toBeNull();
        expect((await store.get('a', b[0])).rawPrompt).toBe('b');
    });

    test('serializes overlapping saves and deletion without resurrecting data', async () => {
        const { index, records, store } = setup();
        await Promise.all([
            store.save('chat', [{ mesId: 1, rawPrompt: 'one' }]),
            store.save('chat', [{ mesId: 1, rawPrompt: 'new one' }]),
            store.delete('chat'),
        ]);
        expect(index.data.size).toBe(0);
        expect(records.data.size).toBe(0);
    });

    test('clears both legacy and migrated archives after pending saves', async () => {
        const { index, records, store } = setup();
        await index.setItem('legacy', [{ mesId: 1, rawPrompt: 'old' }]);
        await Promise.all([store.save('chat', [{ mesId: 1, rawPrompt: 'new' }]), store.clear()]);
        expect(index.data.size).toBe(0);
        expect(records.data.size).toBe(0);
    });
});
