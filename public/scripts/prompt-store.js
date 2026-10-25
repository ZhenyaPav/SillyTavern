/**
 * Stores prompt bodies separately from the small per-chat index. Only prompts
 * being generated or inspected need to be in memory. Storage operations are
 * serialized so a chat switch, deletion, or overlapping save cannot race a write.
 */
export class PromptStore {
    #index;
    #records;
    #createId;
    #pending = Promise.resolve();

    constructor(index, records, createId) {
        this.#index = index;
        this.#records = records;
        this.#createId = createId;
    }

    #enqueue(operation) {
        const result = this.#pending.then(operation);
        this.#pending = result.catch(() => {});
        return result;
    }

    #recordKey(chatId, promptKey) {
        return JSON.stringify([chatId, promptKey]);
    }

    /** Load the index, migrating the old array without discarding any prompts. */
    load(chatId) {
        return this.#enqueue(async () => {
            const stored = await this.#index.getItem(chatId);
            if (Array.isArray(stored)) {
                // The legacy format must be read once. Commit the new index only
                // after every record is safely stored, leaving the old array on failure.
                try {
                    return await this.#write(chatId, stored, stored);
                } catch (error) {
                    // Keep the legacy data in memory on quota/storage failures.
                    // A later save can retry without overwriting the archive
                    // with an empty index or just the newest generation.
                    console.warn('Could not migrate itemized prompts', error);
                    return stored;
                }
            }
            return stored?.version === 2 ? stored.prompts : [];
        });
    }

    /** Snapshot IDs immediately, before messages can be moved or deleted. */
    save(chatId, prompts) {
        const snapshot = prompts.map(prompt => ({ ...prompt }));
        return this.#enqueue(() => this.#write(chatId, snapshot));
    }

    async #write(chatId, prompts, previous = undefined) {
        previous ??= await this.#index.getItem(chatId);
        const summaries = [];
        const createdKeys = [];
        try {
            for (const prompt of prompts) {
                if (prompt.promptKey) {
                    summaries.push(prompt);
                    continue;
                }
                const promptKey = this.#createId();
                const recordKey = this.#recordKey(chatId, promptKey);
                await this.#records.setItem(recordKey, prompt);
                createdKeys.push(recordKey);
                summaries.push({ mesId: prompt.mesId, promptKey, hasRawPrompt: Boolean(prompt.rawPrompt) });
            }

            const next = { version: 2, prompts: summaries };
            if (createdKeys.length || JSON.stringify(previous) !== JSON.stringify(next)) {
                await this.#index.setItem(chatId, next);
            }
        } catch (error) {
            // Records are immutable: a failed index write leaves the previous
            // archive usable, including after edits and message reordering.
            for (const key of createdKeys) {
                await this.#records.removeItem(key).catch(() => {});
            }
            throw error;
        }

        const retained = new Set(summaries.map(prompt => prompt.promptKey));
        for (const prompt of previous?.version === 2 ? previous.prompts : []) {
            if (!retained.has(prompt.promptKey)) {
                await this.#records.removeItem(this.#recordKey(chatId, prompt.promptKey)).catch(() => {});
            }
        }
        return summaries;
    }

    /** Read one body and apply its current message ID from the index. */
    get(chatId, prompt) {
        return this.#enqueue(async () => {
            if (!prompt.promptKey) {
                return prompt;
            }
            const record = await this.#records.getItem(this.#recordKey(chatId, prompt.promptKey));
            return record ? { ...record, mesId: prompt.mesId } : null;
        });
    }

    delete(chatId) {
        return this.#enqueue(async () => {
            const stored = await this.#index.getItem(chatId);
            await this.#index.removeItem(chatId);
            for (const prompt of stored?.version === 2 ? stored.prompts : []) {
                await this.#records.removeItem(this.#recordKey(chatId, prompt.promptKey));
            }
        });
    }

    clear() {
        return this.#enqueue(async () => {
            await this.#index.clear();
            await this.#records.clear();
        });
    }
}
