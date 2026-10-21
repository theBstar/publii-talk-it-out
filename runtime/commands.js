/*
 * Talk It Out — spoken command parser.
 *
 * Pure function: transcript text in, intent out. No DOM access, so it can be
 * unit-tested in Node (see tests/commands.test.js).
 *
 * Intents:
 *   { kind: 'text', text }                       dictated text to insert
 *   { kind: 'command', name, args, raw }         a recognised editor command
 *   { kind: 'ai', instruction, raw }             free-form instruction for Claude
 *   { kind: 'ignore' }                           nothing usable (empty / noise)
 */
(function (root) {
    'use strict';

    const NUMBER_WORDS = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
        first: 1, second: 2, third: 3, fourth: 4,
        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6
    };

    // Whisper regularly mishears the wake word "Claude"
    const DEFAULT_WAKE_WORDS = ['editor', 'claude', 'cloud', 'clyde', 'clod', 'claud'];

    // Commands that are safe to recognise even while dictating, because the whole
    // utterance has to match. Anything else needs the wake word or command mode.
    const DICTATION_SAFE = new Set([
        'newParagraph', 'newLine', 'undo', 'redo', 'deleteLast', 'stop',
        'setMode', 'finishDraft', 'cancelDraft', 'help'
    ]);

    // Commands available while drafting an article
    const DRAFT_COMMANDS = new Set([
        'newParagraph', 'newLine', 'deleteLast', 'insertHeading', 'stop', 'setMode',
        'finishDraft', 'cancelDraft', 'setTitle', 'help'
    ]);

    function normalise (text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[‘’]/g, "'")
            .replace(/^[\s"'.,!?;:\-–—]+|[\s"'.,!?;:\-–—]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Keep the original casing of a captured argument, e.g. "replace teh with The"
    function originalSlice (raw, normalisedFragment) {
        if (!normalisedFragment) {
            return '';
        }

        let cleanRaw = String(raw).replace(/\s+/g, ' ');
        let index = cleanRaw.toLowerCase().indexOf(normalisedFragment);

        if (index === -1) {
            return normalisedFragment;
        }

        return cleanRaw.substr(index, normalisedFragment.length);
    }

    function toLevel (word, fallback) {
        if (!word) {
            return fallback;
        }

        return NUMBER_WORDS[String(word).trim()] || fallback;
    }

    const BLOCK_TARGETS = [
        { re: /^(?:a |an )?(?:sub ?heading|subtitle)$/, type: 'heading', level: 3 },
        { re: /^(?:a |an )?(?:heading|header|title)(?: (?:level )?(one|two|three|four|1|2|3|4))?$/, type: 'heading', level: 2 },
        { re: /^(?:a |an )?(?:h)(1|2|3|4)$/, type: 'heading', level: 2 },
        { re: /^(?:a |an )?(?:normal |regular |plain )?(?:paragraph|text|body text)$/, type: 'paragraph' },
        { re: /^(?:a |an )?(?:block ?quote|quote|quotation)$/, type: 'quote' },
        { re: /^(?:a |an )?(?:numbered|ordered) list$/, type: 'numbered_list' },
        { re: /^(?:a |an )?(?:bullet(?:ed)?|unordered)? ?(?:point )?list$/, type: 'bullet_list' },
        { re: /^(?:bullet points?|bullets)$/, type: 'bullet_list' }
    ];

    function parseBlockTarget (phrase) {
        for (const target of BLOCK_TARGETS) {
            let match = phrase.match(target.re);

            if (match) {
                return {
                    type: target.type,
                    level: target.type === 'heading' ? toLevel(match[1], target.level) : 0
                };
            }
        }

        return null;
    }

    // Each rule: [regex on normalised text, builder(match, raw) -> { name, args } | null]
    const RULES = [
        [/^new paragraph$|^paragraph$/, () => ({ name: 'newParagraph' })],
        [/^new line$|^line break$/, () => ({ name: 'newLine' })],
        [/^undo(?: that| last)?$/, () => ({ name: 'undo' })],
        [/^redo(?: that)?$/, () => ({ name: 'redo' })],
        [/^(?:delete|scratch|remove|erase) (?:that|this)$|^scratch that$/, () => ({ name: 'deleteLast' })],
        [/^(?:delete|remove) (?:the )?(?:last|previous) (word|sentence|paragraph)$/, m => ({ name: 'deleteUnit', args: { unit: m[1] } })],
        [/^(?:delete|remove) (?:this|the|current|the current) (?:paragraph|block|line)$/, () => ({ name: 'deleteBlock' })],
        [/^(?:delete|remove) (?:the )?selection$/, () => ({ name: 'deleteSelection' })],

        [/^(?:stop|pause)(?: listening| dictation| dictating)?$|^go to sleep$|^mic off$/, () => ({ name: 'stop' })],
        [/^(?:switch to |start |go to )?(?:dictation|dictating|dictate)(?: mode)?$/, () => ({ name: 'setMode', args: { mode: 'dictate' } })],
        [/^(?:switch to |go to )?(?:command|commands|edit|editing) mode$|^switch to (?:commands|editing)$/, () => ({ name: 'setMode', args: { mode: 'command' } })],
        [/^(?:start|begin|new)(?: a| an)? (?:new )?(?:draft|article)(?: mode)?$|^draft mode$/, () => ({ name: 'setMode', args: { mode: 'draft' } })],
        [/^(?:finish|done|end|complete|wrap up)(?: the| my)? (?:draft|drafting|article)$|^(?:create|build|write)(?: the| my)? (?:draft|post|article)$|^i'?m done drafting$/, () => ({ name: 'finishDraft' })],
        [/^(?:cancel|discard|throw away)(?: the| this)? draft$/, () => ({ name: 'cancelDraft' })],
        [/^(?:help|what can i say|show commands|list commands)$/, () => ({ name: 'help' })],

        [/^save(?: the)?(?: draft| post| article| page| it| changes)?$/, () => ({ name: 'save' })],
        [/^(?:read|read back|read that|read it|read this)(?: paragraph| block| back)?$|^read (?:me )?(?:the )?(?:current )?paragraph$/, () => ({ name: 'readBack' })],

        [/^(?:go to|jump to|move to|go)(?: the)? (end|bottom|start|beginning|top)(?: of (?:the )?(?:post|document|article))?$/, m => ({
            name: 'navigate', args: { to: /end|bottom/.test(m[1]) ? 'end' : 'start' }
        })],
        [/^(?:go to |move to )?(?:the )?(next|previous|last) (?:paragraph|block)$/, m => ({
            name: 'navigate', args: { to: m[1] === 'next' ? 'next' : 'previous' }
        })],

        [/^select (?:this |the |current )?(?:paragraph|block)$/, () => ({ name: 'selectBlock' })],
        [/^select (?:the )?(?:last|previous) (word|sentence)$/, m => ({ name: 'selectUnit', args: { unit: m[1] } })],
        [/^select all$/, () => ({ name: 'selectAll' })],

        [/^(?:set|change|make)? ?(?:the )?(?:post |article )?title (?:to|is|as) (.+)$/, (m, raw) => ({
            name: 'setTitle', args: { text: originalSlice(raw, m[1]) }
        })],
        [/^title (.+)$/, (m, raw) => ({ name: 'setTitle', args: { text: originalSlice(raw, m[1]) } })],

        [/^(?:make|turn|convert|change)(?: this| that| it| the current)?(?: paragraph| block| line)? (?:into|to|a|an|in to)(?: a| an)? (.+)$/, m => {
            let target = parseBlockTarget(m[1]);
            return target ? { name: 'setBlockType', args: target } : null;
        }],
        [/^(?:make|turn) (?:this|that|it) (?:a |an )?(.+)$/, m => {
            let target = parseBlockTarget(m[1]);
            return target ? { name: 'setBlockType', args: target } : null;
        }],

        [/^(?:insert |add |new )?(heading|header|sub ?heading|section)(?: (?:level )?(one|two|three|four|1|2|3|4))?[,:]? (.+)$/, (m, raw) => ({
            name: 'insertHeading',
            args: {
                level: /sub/.test(m[1]) ? 3 : toLevel(m[2], 2),
                text: originalSlice(raw, m[3])
            }
        })],

        [/^(bold|italicize|italicise|italic|underline|unbold)(?: that| this| it| the selection| selection)?$/, m => ({
            name: 'format', args: { style: m[1].indexOf('ital') === 0 ? 'italic' : m[1] }
        })],
        [/^(bold|italicize|italicise|underline) (.+)$/, (m, raw) => ({
            name: 'formatPhrase',
            args: { style: m[1].indexOf('ital') === 0 ? 'italic' : m[1], phrase: originalSlice(raw, m[2]) }
        })],

        [/^(?:replace|change|swap) (.+?) (?:with|to|for) (.+)$/, (m, raw) => {
            // "change this to something punchier" is an instruction, not a find/replace
            if (/^(?:this|that|it|the (?:paragraph|sentence|intro|introduction|ending|conclusion|title|tone))$/.test(m[1])) {
                return null;
            }

            return { name: 'replace', args: { find: originalSlice(raw, m[1]), replacement: originalSlice(raw, m[2]) } };
        }],
        [/^(?:delete|remove|erase) (?:the word |the phrase )?(.+)$/, (m, raw) => ({
            name: 'deletePhrase', args: { phrase: originalSlice(raw, m[1]) }
        })],
        [/^select (?:the word |the phrase )?(.+)$/, (m, raw) => ({
            name: 'selectPhrase', args: { phrase: originalSlice(raw, m[1]) }
        })],
        [/^(?:type|insert|write|say) (.+)$/, (m, raw) => ({
            name: 'insertText', args: { text: originalSlice(raw, m[1]) }
        })]
    ];

    function matchCommand (raw) {
        let text = normalise(raw);

        if (!text) {
            return null;
        }

        for (const [re, build] of RULES) {
            let match = text.match(re);

            if (match) {
                let command = build(match, String(raw).trim().replace(/[.!?]+$/, ''));

                if (command) {
                    command.args = command.args || {};
                    command.raw = raw;
                    return command;
                }
            }
        }

        return null;
    }

    function stripWakeWord (raw, wakeWords) {
        let words = (wakeWords && wakeWords.length ? wakeWords : DEFAULT_WAKE_WORDS)
            .map(word => String(word).trim().toLowerCase())
            .filter(Boolean)
            .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        let re = new RegExp('^\\s*(?:hey |ok |okay )?(?:' + words.join('|') + ')\\b[\\s,.:;!?-]*', 'i');
        let match = String(raw).match(re);

        if (!match) {
            return null;
        }

        return String(raw).slice(match[0].length).trim();
    }

    // Whisper produces these on silence or background noise
    const HALLUCINATIONS = [
        /^(?:thank you|thanks)(?: (?:so much|very much))?(?: for watching)?[.!]*$/i,
        /^(?:you|bye|okay|so|uh|um|hmm)[.!?]*$/i,
        /^\[.*\]$|^\(.*\)$|^♪.*$/,
        /^(?:subtitles|captions) by .*$/i,
        /^\.+$/
    ];

    function isLikelyNoise (text, durationSeconds) {
        let clean = String(text || '').replace(/\[BLANK_AUDIO\]/gi, '').trim();

        if (!clean) {
            return true;
        }

        if (durationSeconds !== undefined && durationSeconds > 2) {
            return false;
        }

        return HALLUCINATIONS.some(re => re.test(clean));
    }

    /**
     * @param {string} raw - transcript of one utterance
     * @param {object} options
     *   mode: 'dictate' | 'command' | 'draft'
     *   wakeWords: string[]
     *   aiEnabled: boolean
     */
    function parse (raw, options = {}) {
        let mode = options.mode || 'dictate';
        let text = String(raw || '').replace(/\[BLANK_AUDIO\]/gi, '').trim();

        if (!text) {
            return { kind: 'ignore' };
        }

        let afterWake = stripWakeWord(text, options.wakeWords);
        let forcedCommand = afterWake !== null;
        let body = forcedCommand ? afterWake : text;

        if (!body) {
            return { kind: 'ignore' };
        }

        if (mode === 'draft' && !forcedCommand) {
            let command = matchCommand(body);

            if (command && DRAFT_COMMANDS.has(command.name)) {
                // In draft mode only whole, short utterances count as commands, so
                // "heading" commands must be explicit: "heading: why this matters"
                if (command.name !== 'insertHeading' || /^(?:heading|section)\b/i.test(body.trim())) {
                    return Object.assign({ kind: 'command' }, command);
                }
            }

            return { kind: 'text', text: text };
        }

        if (mode === 'dictate' && !forcedCommand) {
            let command = matchCommand(body);

            if (command && DICTATION_SAFE.has(command.name)) {
                return Object.assign({ kind: 'command' }, command);
            }

            return { kind: 'text', text: text };
        }

        // Command mode, or the wake word was used
        let command = matchCommand(body);

        if (command) {
            return Object.assign({ kind: 'command' }, command);
        }

        if (options.aiEnabled) {
            return { kind: 'ai', instruction: body, raw: text };
        }

        return { kind: 'command', name: 'unknown', args: { text: body }, raw: text };
    }

    const api = {
        parse,
        matchCommand,
        normalise,
        stripWakeWord,
        isLikelyNoise,
        parseBlockTarget,
        DEFAULT_WAKE_WORDS
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.TalkItOutNS = root.TalkItOutNS || {};
        root.TalkItOutNS.commands = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
