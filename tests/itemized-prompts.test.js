import { beforeEach, describe, test, expect, jest } from '@jest/globals';

const stores = new Map();
function createInstance({ name }) {
    if (!stores.has(name)) {
        const data = new Map();
        stores.set(name, {
            data,
            getItem: jest.fn(async key => structuredClone(data.get(key) ?? null)),
            setItem: jest.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
            removeItem: jest.fn(async key => { data.delete(key); }),
            clear: jest.fn(async () => { data.clear(); }),
        });
    }
    return stores.get(name);
}
let chatId = 'chat';
const emit = jest.fn(async () => {});
const elements = new Map();
const show = jest.fn(async () => {});
const diffMain = jest.fn(() => []);
class Popup {
    constructor() {
        this.dlg = { querySelector: selector => elements.get(selector) };
    }
    show = show;
}
const copyText = jest.fn(async () => {});
let nextId = 0;
await jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: { createInstance }, DOMPurify: { sanitize: text => text },
    DiffMatchPatch: class {
        diff_main = diffMain;
        diff_prettyHtml = () => '';
    },
}));
await jest.unstable_mockModule('../public/script.js', () => ({
    chat: [], event_types: {}, eventSource: { emit }, getCurrentChatId: () => chatId, reloadCurrentChat: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup, POPUP_TYPE: {} }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {}, registerDebugFunction: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => true }));
await jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn(async () => '') }));
await jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getFriendlyTokenizerName: () => ({ tokenizerName: 'test' }), getTokenCountAsync: async () => 0,
}));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ copyText, uuidv4: () => String(++nextId) }));
const prompts = await import('../public/scripts/itemized-prompts.js');

describe('itemized prompt integration', () => {
    beforeEach(async () => {
        chatId = 'chat';
        await prompts.clearItemizedPrompts();
        jest.clearAllMocks();
        elements.clear();
        for (const selector of ['#diffPrevPrompt', '#copyPromptToClipboard', '#showRawPrompt']) {
            const handlers = {};
            elements.set(selector, { style: {}, handlers, addEventListener: (event, callback) => { handlers[event] = callback; } });
        }
        global.$ = () => ({ first: () => ({ text: () => '' }), slideToggle: jest.fn() });
        global.toastr = { info: jest.fn() };
        global.document = { createElement: () => ({}), getElementById: () => ({ replaceChildren: jest.fn() }) };
    });

    test('overlapping saves release bodies without leaving stale record keys', async () => {
        prompts.itemizedPrompts.push({ mesId: 1, rawPrompt: 'one' });
        await Promise.all([prompts.saveItemizedPrompts(chatId), prompts.saveItemizedPrompts(chatId)]);
        expect(prompts.itemizedPrompts[0].rawPrompt).toBeUndefined();
        expect(stores.get('SillyTavern_PromptRecords').setItem).toHaveBeenCalledTimes(1);
        await prompts.promptItemize(prompts.itemizedPrompts, 1);
        expect(show).toHaveBeenCalledTimes(1);
    });

    test('old prompt inspection and copying load one body and do not hydrate the archive', async () => {
        prompts.itemizedPrompts.push(...Array.from({ length: 50 }, (_, i) => ({
            mesId: 2 * i + 1, rawPrompt: `prompt ${i}`, main_api: 'openai',
        })));
        await prompts.saveItemizedPrompts(chatId);
        const records = stores.get('SillyTavern_PromptRecords');
        records.getItem.mockClear();
        await prompts.loadItemizedPrompts(chatId);
        expect(records.getItem).not.toHaveBeenCalled();
        await prompts.promptItemize(prompts.itemizedPrompts, 21);
        await elements.get('#copyPromptToClipboard').handlers.pointerup();
        expect(copyText).toHaveBeenCalledWith('prompt 10');
        expect(records.getItem).toHaveBeenCalledTimes(1);
        expect(prompts.itemizedPrompts.every(entry => !entry.rawPrompt)).toBe(true);
        expect(elements.get('#diffPrevPrompt').style.display).toBe('');
    });

    test('editing, swapping and deleting saved entries preserve their bodies and IDs', async () => {
        prompts.itemizedPrompts.push({ mesId: 1, rawPrompt: 'one' }, { mesId: 3, rawPrompt: 'three' });
        await prompts.saveItemizedPrompts(chatId);
        await prompts.replaceItemizedPromptText(1, 'edited');
        prompts.swapItemizedPrompts(1, 3);
        prompts.deleteItemizedPromptForMessage(1);
        await prompts.saveItemizedPrompts(chatId);
        await prompts.loadItemizedPrompts(chatId);
        expect(prompts.itemizedPrompts).toHaveLength(1);
        expect(prompts.itemizedPrompts[0].mesId).toBe(2);
        await prompts.promptItemize(prompts.itemizedPrompts, 2);
        await elements.get('#copyPromptToClipboard').handlers.pointerup();
        expect(copyText).toHaveBeenCalledWith('edited');
    });

    test('diffing fetches the previous prompt only on request', async () => {
        prompts.itemizedPrompts.push({ mesId: 1, rawPrompt: 'one' }, { mesId: 3, rawPrompt: 'three' });
        await prompts.saveItemizedPrompts(chatId);
        const records = stores.get('SillyTavern_PromptRecords');
        records.getItem.mockClear();
        await prompts.promptItemize(prompts.itemizedPrompts, 3);
        expect(records.getItem).toHaveBeenCalledTimes(1);
        await elements.get('#diffPrevPrompt').handlers.click();
        expect(records.getItem).toHaveBeenCalledTimes(2);
        expect(diffMain).toHaveBeenCalledWith('one', 'three');
        expect(prompts.itemizedPrompts.every(entry => !entry.rawPrompt)).toBe(true);
    });

    test('a failed migration keeps older prompts when another reply is saved', async () => {
        const index = stores.get('SillyTavern_Prompts');
        const records = stores.get('SillyTavern_PromptRecords');
        await index.setItem(chatId, [{ mesId: 1, rawPrompt: 'old' }]);
        records.setItem.mockRejectedValueOnce(new Error('quota'));
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await prompts.loadItemizedPrompts(chatId);
        warning.mockRestore();
        prompts.itemizedPrompts.push({ mesId: 3, rawPrompt: 'new' });
        await prompts.saveItemizedPrompts(chatId);
        await prompts.loadItemizedPrompts(chatId);
        expect(prompts.itemizedPrompts).toHaveLength(2);
        await prompts.promptItemize(prompts.itemizedPrompts, 1);
        await elements.get('#copyPromptToClipboard').handlers.pointerup();
        expect(copyText).toHaveBeenCalledWith('old');
    });

    test('a later chat load wins over a still-pending older load', async () => {
        const index = stores.get('SillyTavern_Prompts');
        await index.setItem('a', [{ mesId: 1, rawPrompt: 'a' }]);
        await index.setItem('b', [{ mesId: 3, rawPrompt: 'b' }]);
        await Promise.all([prompts.loadItemizedPrompts('a'), prompts.loadItemizedPrompts('b')]);
        expect(prompts.itemizedPrompts.map(entry => entry.mesId)).toEqual([3]);
    });
});
