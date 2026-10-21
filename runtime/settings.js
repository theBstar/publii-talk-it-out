/*
 * Talk It Out — settings.
 *
 * Stored in localStorage. Publii's window and the plugin's settings iframe are
 * both file:// pages, so they share this storage. The values live in the Publii
 * app profile on this machine only and are never written into the site folder,
 * which keeps API keys out of site backups and sync.
 */
(function (root) {
    'use strict';

    const STORAGE_KEY = 'publii-talk-it-out:settings';

    const MODEL_PRICES = {
        // USD per million tokens: [input, output]
        'claude-opus-5-5': [4, 20],
        'claude-sonnet-5-5': [2, 10],
        'claude-haiku-5-5': [0.10, 0.50]
    };

    const DEFAULTS = {
        stt: {
            provider: 'local',                         // 'local' | 'cloud'
            localModel: 'onnx-community/whisper-base.en',
            language: 'en',                            // only used by multilingual models
            cloudBaseUrl: 'https://api.openai.com/v1',
            cloudApiKey: '',
            cloudModel: 'gpt-4o-mini-transcribe'
        },
        vad: {
            silenceMs: 800,
            sensitivity: 0.5
        },
        ai: {
            enabled: false,
            apiKey: '',
            model: 'claude-opus-5-5',
            draftStyle: 'Keep my voice and wording. Light cleanup only. Organise into sections with short headings.'
        },
        commands: {
            wakeWords: 'editor, claude'
        },
        ui: {
            preferredEditor: 'tinymce',                // 'tinymce' | 'blockeditor' | 'markdown'
            speakFeedback: false,
            panelPosition: null
        }
    };

    function deepMerge (target, source) {
        let output = Object.assign({}, target);

        Object.keys(source || {}).forEach(key => {
            let value = source[key];

            if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
                output[key] = deepMerge(target[key], value);
            } else if (value !== undefined) {
                output[key] = value;
            }
        });

        return output;
    }

    function load () {
        try {
            let saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return deepMerge(DEFAULTS, saved);
        } catch (e) {
            return deepMerge(DEFAULTS, {});
        }
    }

    function save (settings) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
            return true;
        } catch (e) {
            console.warn('[Talk It Out] Could not save settings', e);
            return false;
        }
    }

    function update (patch) {
        let next = deepMerge(load(), patch);
        save(next);
        return next;
    }

    function wakeWordList (settings) {
        return String(settings.commands.wakeWords || '')
            .split(',')
            .map(word => word.trim().toLowerCase())
            .filter(Boolean)
            .concat(
                // Common Whisper mishearings of "Claude"
                /claude/i.test(settings.commands.wakeWords) ? ['cloud', 'clyde', 'clod', 'claud'] : []
            );
    }

    function estimateCost (model, inputTokens, outputTokens) {
        let price = MODEL_PRICES[model];

        if (!price) {
            return null;
        }

        return (inputTokens * price[0] + outputTokens * price[1]) / 1e6;
    }

    root.TalkItOutNS = root.TalkItOutNS || {};
    root.TalkItOutNS.settings = {
        STORAGE_KEY,
        DEFAULTS,
        MODEL_PRICES,
        load,
        save,
        update,
        wakeWordList,
        estimateCost
    };
})(window);
