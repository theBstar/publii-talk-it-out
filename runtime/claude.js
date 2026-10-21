/*
 * Talk It Out — Claude integration (optional).
 *
 * Two jobs:
 *   draftArticle: spoken transcript -> structured article (title + blocks)
 *   editDocument: spoken instruction + numbered blocks -> block operations
 *
 * Uses the official Anthropic SDK in browser mode with the author's own API
 * key. Every call is billed to that key; usage is added to a per-session
 * cost meter shown in the panel.
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';

    // Server-side refusal fallback ("default" routing) is available for these
    const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

    // Above this the editor sends only the blocks around the cursor
    const MAX_DOCUMENT_CHARS = 40000;
    const WINDOW_BLOCKS = 25;

    const BLOCK_SCHEMA = {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'level', 'text', 'items'],
        properties: {
            type: { type: 'string', enum: ['paragraph', 'heading', 'bullet_list', 'numbered_list', 'quote'] },
            level: { type: 'integer', description: 'Heading level 2-4 for headings, 0 otherwise' },
            text: { type: 'string', description: 'Inline content for paragraph, heading and quote; empty for lists' },
            items: { type: 'array', items: { type: 'string' }, description: 'List items for lists; empty otherwise' }
        }
    };

    const DRAFT_SCHEMA = {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'blocks'],
        properties: {
            title: { type: 'string' },
            blocks: { type: 'array', items: BLOCK_SCHEMA }
        }
    };

    const EDIT_SCHEMA = {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'title', 'ops'],
        properties: {
            summary: { type: 'string', description: 'One short sentence describing the change, or why nothing changed' },
            title: { type: 'string', description: 'New post title, or empty string to leave it unchanged' },
            ops: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['action', 'index', 'blocks'],
                    properties: {
                        action: { type: 'string', enum: ['replace', 'insert_after', 'delete'] },
                        index: { type: 'integer', description: 'Block number from the document; -1 with insert_after inserts at the top' },
                        blocks: { type: 'array', items: BLOCK_SCHEMA }
                    }
                }
            }
        }
    };

    const DRAFT_SYSTEM = [
        'You turn an unedited, spoken dictation transcript into a first draft of a blog post, in the author\'s own words.',
        '',
        'The transcript came from speech recognition, so expect filler words, false starts, repetitions, run-on sentences and the occasional misheard word. Clean those up: remove fillers ("um", "you know", "like"), keep the final version of a restated thought, fix grammar and punctuation, and correct obvious recognition errors when the intended word is clear from context.',
        '',
        'Keep the author\'s voice, vocabulary, perspective and claims. This is their article, not yours: do not add facts, examples, statistics, quotes, links, opinions or conclusions they did not say, and do not pad it out. If something they said is unclear, keep it close to what they said rather than guessing.',
        '',
        'Structure it for reading: short paragraphs, a heading (level 2, or 3 for sub-points) wherever the topic shifts, and a list where they enumerated things. Follow any structure they dictated explicitly, shown as [new paragraph] and [heading: ...] markers.',
        '',
        'Title: use the title they dictated if there is one; otherwise write a short, specific title from what they actually said. Do not repeat the title as the first block.'
    ].join('\n');

    const EDIT_SYSTEM = [
        'You are an in-place editor for a blog post that is open in an editor. The author speaks an instruction; you return the smallest set of block operations that carries it out.',
        '',
        'The post is given as numbered blocks. The instruction was transcribed by speech recognition, so interpret it charitably (for example "cloud" may be "Claude", homophones may be swapped). Words like "this", "here" or "it" refer to the selected text if there is a selection, otherwise to the block at the cursor.',
        '',
        'Rules:',
        '- Change only what the instruction asks for. Copy every untouched sentence, word and inline formatting exactly.',
        '- "replace" swaps one block for one or more new blocks; "insert_after" adds blocks after a block number (-1 for the top); "delete" removes a block.',
        '- Never touch blocks marked "other" (images, embeds, code) and never edit blocks that were not shown to you.',
        '- Keep the author\'s voice. Do not add facts, statistics, links or claims they did not ask for.',
        '- Set "title" only when the instruction is about the post title; otherwise return an empty string.',
        '- If the instruction is not an editing request or is too unclear to act on, return no operations and say so in the summary.'
    ].join('\n');

    let sdkPromise = null;

    function loadSdk () {
        if (!sdkPromise) {
            sdkPromise = import(SDK_URL).then(module => module.default || module.Anthropic).catch(error => {
                sdkPromise = null;
                throw new Error('Could not load the Anthropic SDK (are you offline?): ' + error.message);
            });
        }

        return sdkPromise;
    }

    const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    const listeners = new Set();

    function recordUsage (model, message) {
        let u = message.usage || {};
        let input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        let output = u.output_tokens || 0;
        let cost = NS.settings.estimateCost(message.model || model, input, output);

        if (cost === null) {
            cost = NS.settings.estimateCost(model, input, output) || 0;
        }

        usage.calls++;
        usage.inputTokens += input;
        usage.outputTokens += output;
        usage.cost += cost;
        listeners.forEach(listener => listener(Object.assign({}, usage)));
    }

    function friendlyError (Anthropic, error) {
        if (error instanceof Anthropic.AuthenticationError) return new Error('Your Anthropic API key was rejected. Check it in Talk It Out settings.');
        if (error instanceof Anthropic.PermissionDeniedError) return new Error('This API key cannot use the selected model.');
        if (error instanceof Anthropic.NotFoundError) return new Error('The selected Claude model was not found for this API key.');
        if (error instanceof Anthropic.RateLimitError) return new Error('Claude is rate limiting this key. Wait a moment and try again.');
        if (error instanceof Anthropic.BadRequestError) return new Error('Claude rejected the request: ' + error.message);
        if (error instanceof Anthropic.APIConnectionError) return new Error('Could not reach Claude. Check your internet connection.');
        if (error instanceof Anthropic.APIError) return new Error('Claude API error ' + error.status + ': ' + error.message);
        return error;
    }

    async function callStructured ({ system, content, schema, effort, maxTokens }) {
        let settings = NS.settings.load();

        if (!settings.ai.enabled || !settings.ai.apiKey) {
            throw new Error('Claude is not set up. Add an API key in Talk It Out settings.');
        }

        let Anthropic = await loadSdk();
        let client = new Anthropic({ apiKey: settings.ai.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
        let model = settings.ai.model;
        let params = {
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content }],
            output_config: {
                effort,
                format: { type: 'json_schema', schema }
            }
        };

        if (FALLBACK_MODELS.has(model)) {
            params.betas = ['server-side-fallback-2026-07-01'];
            params.fallbacks = 'default';
        }

        let message;

        try {
            message = await client.beta.messages.stream(params).finalMessage();
        } catch (error) {
            throw friendlyError(Anthropic, error);
        }

        recordUsage(model, message);

        if (message.stop_reason === 'refusal') {
            let category = message.stop_details && message.stop_details.category;
            throw new Error('Claude declined this request' + (category ? ' (' + category + ')' : '') + '.');
        }

        if (message.stop_reason === 'max_tokens') {
            throw new Error('Claude ran out of room before finishing. Try a shorter section.');
        }

        let text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');

        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error('Claude returned an unexpected response. Please try again.');
        }
    }

    function inlineFormatNote (format) {
        return format === 'markdown'
            ? 'Write inline formatting as Markdown (**bold**, _italic_, [text](https://...)). No HTML.'
            : 'Write inline formatting as HTML using only <strong>, <em>, <a href="https://...">, <code>. No block-level tags inside "text" or "items".';
    }

    async function draftArticle ({ transcript, format }) {
        let settings = NS.settings.load();
        let content = [
            '<transcript>',
            transcript,
            '</transcript>',
            '',
            '<style_notes>',
            settings.ai.draftStyle || 'None.',
            '</style_notes>',
            '',
            inlineFormatNote(format)
        ].join('\n');

        let result = await callStructured({
            system: DRAFT_SYSTEM,
            content,
            schema: DRAFT_SCHEMA,
            effort: 'medium',
            maxTokens: 32000
        });

        return {
            title: String(result.title || '').trim(),
            blocks: (result.blocks || []).map(NS.common.normaliseBlock)
        };
    }

    // Pick which blocks to show the model
    function visibleBlocks (blocks, cursorIndex) {
        let total = blocks.reduce((sum, block) => sum + (block.content ? block.content.length : 20), 0);

        if (total <= MAX_DOCUMENT_CHARS) {
            return { shown: new Set(blocks.map(block => block.index)), partial: false };
        }

        let center = cursorIndex >= 0 ? cursorIndex : blocks.length - 1;
        let shown = new Set();

        blocks.forEach(block => {
            if (Math.abs(block.index - center) <= WINDOW_BLOCKS) {
                shown.add(block.index);
            }
        });

        return { shown, partial: true };
    }

    function renderDocument (blocks, shown) {
        let lines = [];
        let hiddenRun = null;

        blocks.forEach(block => {
            if (!shown.has(block.index)) {
                // Headings outside the window still give the model an outline
                if (/^heading/.test(block.kind)) {
                    lines.push('[' + block.index + '] ' + block.kind + ' (outline only, not editable): ' + NS.common.stripHtml(block.content).trim());
                } else if (!hiddenRun) {
                    hiddenRun = true;
                    lines.push('... (some blocks not shown) ...');
                }

                return;
            }

            hiddenRun = null;

            if (block.content === null) {
                lines.push('[' + block.index + '] ' + block.kind + ' (do not modify)');
            } else {
                lines.push('[' + block.index + '] ' + block.kind + ': ' + block.content);
            }
        });

        return lines.join('\n');
    }

    async function editDocument ({ instruction, blocks, cursorIndex, selection, title, format }) {
        let { shown } = visibleBlocks(blocks, cursorIndex);
        let content = [
            '<title>' + (title || '(untitled)') + '</title>',
            '',
            '<document>',
            blocks.length ? renderDocument(blocks, shown) : '(empty)',
            '</document>',
            '',
            '<cursor>' + (cursorIndex >= 0 ? 'Block ' + cursorIndex : 'Not in a block') + '</cursor>',
            selection ? '<selection>' + selection + '</selection>' : '<selection>(none)</selection>',
            '',
            '<instruction>' + instruction + '</instruction>',
            '',
            inlineFormatNote(format)
        ].join('\n');

        let result = await callStructured({
            system: EDIT_SYSTEM,
            content,
            schema: EDIT_SCHEMA,
            effort: 'low',
            maxTokens: 16000
        });

        let protectedIndexes = new Set(blocks.filter(block => block.content === null).map(block => block.index));
        let rejected = 0;

        let ops = (result.ops || []).filter(op => {
            let index = parseInt(op.index, 10);
            let insertAtTop = op.action === 'insert_after' && index === -1;
            let valid = insertAtTop || (shown.has(index) && (op.action === 'insert_after' || !protectedIndexes.has(index)));

            if (!valid) {
                rejected++;
            }

            return valid;
        }).map(op => ({
            action: op.action,
            index: parseInt(op.index, 10),
            blocks: (op.blocks || []).map(NS.common.normaliseBlock)
        }));

        return {
            summary: String(result.summary || '').trim(),
            title: String(result.title || '').trim(),
            ops,
            rejected
        };
    }

    // Validates the key and model without generating tokens
    async function testConnection (apiKey, model) {
        let Anthropic = await loadSdk();
        let client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });

        try {
            let info = await client.models.retrieve(model);
            return info.display_name || model;
        } catch (error) {
            throw friendlyError(Anthropic, error);
        }
    }

    NS.claude = {
        draftArticle,
        editDocument,
        testConnection,
        usage: () => Object.assign({}, usage),
        onUsage: listener => listeners.add(listener),
        SDK_URL
    };
})(window);
