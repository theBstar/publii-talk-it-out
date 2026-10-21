/*
 * Talk It Out — session engine.
 *
 * Mic -> utterances -> transcription -> intent -> editor action.
 * Utterances are processed strictly in order, so a command always applies to
 * the text dictated before it.
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const DRAFT_KEY = 'publii-talk-it-out:draft';

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const plain = text => String(text || '').replace(/ /g, ' ');

    class Session {
        constructor () {
            this.settings = NS.settings.load();
            this.mode = 'dictate';
            this.listening = false;
            this.adapter = null;
            this.lastInserted = '';
            this.queue = Promise.resolve();
            this.pendingUtterances = 0;
            this.engine = null;
            this.engineReady = false;
            this.ui = null;
            this.draft = this._loadDraft();
        }

        attachUI (ui) {
            this.ui = ui;
        }

        /* ---------------- settings & engines ---------------- */

        settingsChanged () {
            let previous = this.settings;
            this.settings = NS.settings.load();

            if (this.recorder) {
                this.recorder.updateOptions({
                    silenceMs: this.settings.vad.silenceMs,
                    sensitivity: this.settings.vad.sensitivity
                });
            }

            if (previous.stt.provider !== this.settings.stt.provider || previous.stt.localModel !== this.settings.stt.localModel) {
                this.engine = null;
                this.engineReady = false;
            }

            if (this.ui) {
                this.ui.render();
            }
        }

        _engine () {
            if (!this.engine) {
                this.engine = NS.stt.createEngine(() => this.settings, info => this._onModelProgress(info));
            }

            return this.engine;
        }

        _onModelProgress (info) {
            if (this.ui) {
                this.ui.setModelProgress(info);
            }

            this.modelListeners && this.modelListeners.forEach(listener => listener(info));
        }

        onModelProgress (listener) {
            this.modelListeners = this.modelListeners || new Set();
            this.modelListeners.add(listener);
            return () => this.modelListeners.delete(listener);
        }

        async prepareEngine () {
            let engine = this._engine();

            if (!this.engineReady) {
                await engine.load();
                this.engineReady = true;
            }

            return engine;
        }

        /* ---------------- editor ---------------- */

        getAdapter () {
            if (this.adapter && this.adapter.isAlive()) {
                return this.adapter;
            }

            if (this.adapter && this.adapter.destroy) {
                this.adapter.destroy();
            }

            this.adapter = null;
            let route = NS.bridge.editorRoute();

            if (!route) {
                return null;
            }

            let factory = NS.adapters[route.editor];
            this.adapter = factory ? factory.create() : null;

            if (this.adapter && this.keyHandler) {
                this.adapter.onKeydown(this.keyHandler);
            }

            return this.adapter;
        }

        async waitForAdapter (timeoutMs = 10000) {
            let started = Date.now();

            while (Date.now() - started < timeoutMs) {
                let adapter = this.getAdapter();

                if (adapter) {
                    return adapter;
                }

                await sleep(150);
            }

            return null;
        }

        setKeyHandler (handler) {
            this.keyHandler = handler;
        }

        onRoute () {
            let route = NS.bridge.editorRoute();

            if (!route && this.listening) {
                this.stop('Paused — you left the editor.');
            }

            this.adapter = null;

            if (route) {
                this.waitForAdapter().then(() => this.ui && this.ui.render());
            }

            if (this.ui) {
                this.ui.render();
            }
        }

        /* ---------------- listening ---------------- */

        async start () {
            if (this.listening) {
                return;
            }

            if (!NS.bridge.editorRoute()) {
                this.notify('Open a post or page in the editor first.', 'warn');
                return;
            }

            this.listening = true;
            this.ui && this.ui.render();

            try {
                this.setStatus(this.settings.stt.provider === 'local' && !this.engineReady ? 'Loading speech model…' : 'Starting microphone…');
                await this.prepareEngine();

                this.recorder = new NS.audio.Recorder({
                    silenceMs: this.settings.vad.silenceMs,
                    sensitivity: this.settings.vad.sensitivity,
                    onLevel: (level, speaking) => this.ui && this.ui.setLevel(level, speaking),
                    onSpeechStart: () => this.setStatus('Hearing you…'),
                    onUtterance: (pcm, duration) => this._enqueue(pcm, duration)
                });

                await this.recorder.start();

                if (!this.listening) {
                    this.recorder.stop();
                    return;
                }

                this.setStatus(this._idleStatus());
            } catch (error) {
                this.listening = false;
                this.recorder = null;
                let message = error && error.name === 'NotAllowedError'
                    ? 'Microphone access was blocked. Allow Publii in System Settings → Privacy & Security → Microphone.'
                    : (error && error.message) || String(error);
                this.notify(message, 'error');
                this.setStatus('Not listening');
            }

            this.ui && this.ui.render();
        }

        stop (reason) {
            this.listening = false;

            if (this.recorder) {
                this.recorder.stop();
                this.recorder = null;
            }

            this.setStatus(reason || 'Not listening');
            this.ui && this.ui.setLevel(0, false);
            this.ui && this.ui.render();
        }

        toggle () {
            this.listening ? this.stop() : this.start();
        }

        setMode (mode) {
            this.mode = mode;

            if (mode === 'draft' && !this.draft) {
                this.draft = { segments: [], title: '', startedAt: Date.now() };
                this._saveDraft();
            }

            this.setStatus(this._idleStatus());
            this.ui && this.ui.render();
        }

        _idleStatus () {
            if (!this.listening) {
                return 'Not listening';
            }

            return {
                dictate: 'Listening — speak to type',
                command: 'Listening for commands',
                draft: 'Drafting — talk through your article'
            }[this.mode];
        }

        setStatus (text) {
            this.status = text;
            this.ui && this.ui.setStatus(text);
        }

        notify (message, kind = 'info', actions) {
            this.ui && this.ui.notify(message, kind, actions);

            if (this.settings.ui.speakFeedback && kind !== 'info-silent') {
                this.speak(message.split(/(?<=\.)\s/)[0]);
            }
        }

        speak (text) {
            if (!window.speechSynthesis || !text) {
                return Promise.resolve();
            }

            return new Promise(resolve => {
                let utterance = new SpeechSynthesisUtterance(text);
                // Don't transcribe our own voice
                this.recorder && this.recorder.setMuted(true);
                utterance.onend = utterance.onerror = () => {
                    setTimeout(() => this.recorder && this.recorder.setMuted(false), 250);
                    resolve();
                };
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(utterance);
            });
        }

        /* ---------------- utterance pipeline ---------------- */

        _enqueue (pcm, duration) {
            this.pendingUtterances++;
            this.setStatus('Transcribing…');

            this.queue = this.queue
                .then(() => this._process(pcm, duration))
                .catch(error => this.notify((error && error.message) || String(error), 'error'))
                .then(() => {
                    this.pendingUtterances--;

                    if (!this.pendingUtterances) {
                        this.setStatus(this._idleStatus());
                    }
                });
        }

        async _process (pcm, duration) {
            let engine = this._engine();
            let adapter = this.getAdapter();
            let prompt = adapter && this.mode !== 'draft' ? plain(adapter.textBeforeCursor()) : '';
            let text = await engine.transcribe(pcm, { prompt });
            await this.handleTranscript(text, duration);
        }

        async handleTranscript (text, duration) {
            if (NS.commands.isLikelyNoise(text, duration)) {
                return;
            }

            let intent = NS.commands.parse(text, {
                mode: this.mode,
                wakeWords: NS.settings.wakeWordList(this.settings),
                aiEnabled: this.settings.ai.enabled && !!this.settings.ai.apiKey
            });

            this.ui && this.ui.showHeard(text, intent);
            await this.execute(intent);
        }

        async execute (intent) {
            if (intent.kind === 'ignore') {
                return;
            }

            if (this.mode === 'draft' && intent.kind === 'text') {
                this._draftAdd({ type: 'text', text: intent.text });
                return;
            }

            if (intent.kind === 'ai') {
                await this.runAiEdit(intent.instruction);
                return;
            }

            let adapter = this.getAdapter();

            if (intent.kind === 'text') {
                if (!adapter) {
                    this.notify('The editor is not ready yet.', 'warn');
                    return;
                }

                this.lastInserted = adapter.insertText(intent.text) || '';
                return;
            }

            await this.runCommand(intent, adapter);
        }

        async runCommand (intent, adapter) {
            let args = intent.args || {};
            let draftMode = this.mode === 'draft';
            let needsEditor = !['stop', 'setMode', 'help', 'finishDraft', 'cancelDraft', 'unknown'].includes(intent.name) && !draftMode;

            if (needsEditor && !adapter) {
                this.notify('The editor is not ready yet.', 'warn');
                return;
            }

            // Commands that couldn't be applied literally go to Claude when it's enabled
            const fallBackToAi = async message => {
                if (this.settings.ai.enabled && this.settings.ai.apiKey) {
                    let raw = String(intent.raw || '');
                    let withoutWakeWord = NS.commands.stripWakeWord(raw, NS.settings.wakeWordList(this.settings));
                    await this.runAiEdit(withoutWakeWord !== null ? withoutWakeWord : raw);
                } else {
                    this.notify(message, 'warn');
                }
            };

            switch (intent.name) {
                case 'newParagraph':
                    draftMode ? this._draftAdd({ type: 'break' }) : await adapter.newParagraph();
                    this.lastInserted = '';
                    break;

                case 'newLine':
                    draftMode ? this._draftAdd({ type: 'break' }) : adapter.newLine();
                    this.lastInserted = '';
                    break;

                case 'undo':
                    adapter.undo();
                    this.lastInserted = '';
                    break;

                case 'redo':
                    adapter.redo();
                    break;

                case 'deleteLast':
                    if (draftMode) {
                        this._draftRemoveLast();
                    } else if (this.lastInserted && plain(adapter.textBeforeCursor()).endsWith(plain(this.lastInserted))) {
                        adapter.deleteBackward(this.lastInserted.length);
                        this.lastInserted = '';
                    } else if (!adapter.deleteSelection()) {
                        adapter.undo();
                    }
                    break;

                case 'deleteUnit':
                    if (!adapter.deleteUnit(args.unit)) {
                        this.notify('Nothing to delete there.', 'warn');
                    }
                    this.lastInserted = '';
                    break;

                case 'deleteBlock':
                    adapter.deleteBlock();
                    this.lastInserted = '';
                    break;

                case 'deleteSelection':
                    if (!adapter.deleteSelection()) {
                        this.notify('Nothing is selected.', 'warn');
                    }
                    break;

                case 'selectBlock':
                    adapter.selectBlock();
                    break;

                case 'selectUnit':
                    adapter.selectUnit(args.unit);
                    break;

                case 'selectAll':
                    adapter.selectAll();
                    break;

                case 'selectPhrase':
                    if (!adapter.selectPhrase(args.phrase)) {
                        await fallBackToAi('Couldn\'t find “' + args.phrase + '”.');
                    }
                    break;

                case 'replace':
                    if (adapter.replaceText(args.find, args.replacement)) {
                        this.lastInserted = '';
                    } else {
                        await fallBackToAi('Couldn\'t find “' + args.find + '” to replace.');
                    }
                    break;

                case 'deletePhrase':
                    if (!adapter.deletePhrase(args.phrase)) {
                        await fallBackToAi('Couldn\'t find “' + args.phrase + '”.');
                    }
                    this.lastInserted = '';
                    break;

                case 'format': {
                    // "bold that" with nothing selected means the words just dictated
                    if (!adapter.hasSelection()) {
                        let recent = this.lastInserted && plain(adapter.textBeforeCursor()).endsWith(plain(this.lastInserted))
                            ? this.lastInserted.replace(/^\s+/, '')
                            : '';

                        if (!recent || !adapter.selectBackward(recent.length)) {
                            adapter.selectUnit('word');
                        }
                    }

                    adapter.format(args.style);
                    break;
                }

                case 'formatPhrase':
                    if (adapter.selectPhrase(args.phrase)) {
                        adapter.format(args.style);
                    } else {
                        await fallBackToAi('Couldn\'t find “' + args.phrase + '”.');
                    }
                    break;

                case 'setBlockType':
                    if (!adapter.setBlockType(args)) {
                        this.notify('That block can\'t be converted.', 'warn');
                    }
                    break;

                case 'insertHeading':
                    if (draftMode) {
                        this._draftAdd({ type: 'heading', level: args.level, text: args.text });
                    } else {
                        await adapter.insertHeading(args.level, args.text);
                    }
                    this.lastInserted = '';
                    break;

                case 'navigate':
                    adapter.navigate(args.to);
                    this.lastInserted = '';
                    break;

                case 'readBack': {
                    let text = adapter.getSelectionText() || adapter.currentBlockText();
                    await this.speak(text || 'This paragraph is empty.');
                    break;
                }

                case 'setTitle':
                    if (draftMode && this.draft) {
                        this.draft.title = args.text;
                        this._saveDraft();
                        this.ui && this.ui.render();
                    }

                    NS.bridge.setTitle(args.text);
                    break;

                case 'insertText':
                    this.lastInserted = adapter.insertText(args.text) || '';
                    break;

                case 'save':
                    if (!NS.bridge.getTitle()) {
                        this.notify('Add a title first — say “set the title to …”.', 'warn');
                    } else if (NS.bridge.savePost()) {
                        this.notify('Saved.', 'success');
                    } else {
                        this.notify('Couldn\'t find the save button.', 'warn');
                    }
                    break;

                case 'stop':
                    this.stop();
                    break;

                case 'setMode':
                    this.setMode(args.mode);
                    break;

                case 'finishDraft':
                    await this.finishDraft();
                    break;

                case 'cancelDraft':
                    this.discardDraft();
                    break;

                case 'help':
                    this.ui && this.ui.showHelp(true);
                    break;

                case 'unknown':
                default:
                    this.notify('Not a command I know: “' + ((args && args.text) || intent.raw) + '”. Say “help” for the list' +
                        (this.settings.ai.enabled ? '.' : ', or turn on Claude for free-form edits.'), 'warn');
            }
        }

        /* ---------------- Claude edits ---------------- */

        async runAiEdit (instruction) {
            if (!this.settings.ai.enabled || !this.settings.ai.apiKey) {
                this.notify('Free-form edits need Claude. Turn it on in Talk It Out settings.', 'warn');
                return;
            }

            let adapter = this.getAdapter();

            if (!adapter) {
                this.notify('The editor is not ready yet.', 'warn');
                return;
            }

            this.setStatus('Claude is editing…');
            this.ui && this.ui.setBusy(true);

            try {
                let result = await NS.claude.editDocument({
                    instruction,
                    blocks: adapter.getBlocks(),
                    cursorIndex: adapter.getCurrentBlockIndex(),
                    selection: adapter.getSelectionText(),
                    title: NS.bridge.getTitle(),
                    format: adapter.contentFormat
                });

                if (result.title) {
                    NS.bridge.setTitle(result.title);
                }

                if (result.ops.length) {
                    adapter.applyOps(result.ops);
                }

                this.lastInserted = '';

                if (result.ops.length || result.title) {
                    this.notify((result.summary || 'Done.') + ' Say “undo” to revert.', 'success');
                } else {
                    this.notify(result.summary || 'Claude made no changes.', 'warn');
                }
            } finally {
                this.ui && this.ui.setBusy(false);
                this.setStatus(this._idleStatus());
            }
        }

        /* ---------------- drafting ---------------- */

        _loadDraft () {
            try {
                return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
            } catch (e) {
                return null;
            }
        }

        _saveDraft () {
            try {
                if (this.draft) {
                    localStorage.setItem(DRAFT_KEY, JSON.stringify(this.draft));
                } else {
                    localStorage.removeItem(DRAFT_KEY);
                }
            } catch (e) {}
        }

        _draftAdd (segment) {
            if (!this.draft) {
                this.draft = { segments: [], title: '', startedAt: Date.now() };
            }

            this.draft.segments.push(segment);
            this._saveDraft();
            this.ui && this.ui.render();
        }

        _draftRemoveLast () {
            if (!this.draft || !this.draft.segments.length) {
                return;
            }

            let segments = this.draft.segments;

            // Drop trailing breaks together with the last spoken piece
            while (segments.length && segments[segments.length - 1].type === 'break') {
                segments.pop();
            }

            segments.pop();
            this._saveDraft();
            this.ui && this.ui.render();
        }

        draftTranscript () {
            if (!this.draft) {
                return '';
            }

            let out = '';

            this.draft.segments.forEach(segment => {
                if (segment.type === 'text') {
                    out += (out && !/\n$/.test(out) ? ' ' : '') + segment.text.trim();
                } else if (segment.type === 'break') {
                    out += '\n[new paragraph]\n';
                } else if (segment.type === 'heading') {
                    out += '\n[heading: ' + segment.text + ']\n';
                }
            });

            if (this.draft.title) {
                out = '[title: ' + this.draft.title + ']\n' + out;
            }

            return out.trim();
        }

        // Without Claude: paragraphs and headings exactly as dictated
        _draftToBlocks () {
            let blocks = [];
            let paragraph = '';
            let flush = () => {
                if (paragraph.trim()) {
                    blocks.push({ type: 'paragraph', text: NS.common.escapeHtml(paragraph.trim()) });
                }

                paragraph = '';
            };

            this.draft.segments.forEach(segment => {
                if (segment.type === 'text') {
                    paragraph += (paragraph ? ' ' : '') + segment.text.trim();
                } else if (segment.type === 'break') {
                    flush();
                } else if (segment.type === 'heading') {
                    flush();
                    blocks.push({ type: 'heading', level: segment.level || 2, text: NS.common.escapeHtml(segment.text) });
                }
            });

            flush();
            return blocks;
        }

        async finishDraft ({ useAi } = {}) {
            if (!this.draft || !this.draft.segments.some(segment => segment.type === 'text')) {
                this.notify('Nothing dictated yet — just start talking.', 'warn');
                return;
            }

            let adapter = await this.waitForAdapter(5000);

            if (!adapter) {
                this.notify('Open the post editor to insert the draft.', 'warn');
                return;
            }

            let wantAi = useAi !== undefined ? useAi : (this.settings.ai.enabled && !!this.settings.ai.apiKey);
            let title = this.draft.title;
            let blocks;

            if (wantAi) {
                this.setStatus('Claude is shaping your draft…');
                this.ui && this.ui.setBusy(true);

                try {
                    let result = await NS.claude.draftArticle({ transcript: this.draftTranscript(), format: adapter.contentFormat });
                    blocks = result.blocks;
                    title = title || result.title;
                } catch (error) {
                    this.notify(error.message + ' Your transcript is kept.', 'error', [
                        { label: 'Insert as dictated', run: () => this.finishDraft({ useAi: false }) }
                    ]);
                    return;
                } finally {
                    this.ui && this.ui.setBusy(false);
                    this.setStatus(this._idleStatus());
                }
            } else {
                blocks = this._draftToBlocks();

                if (adapter.contentFormat === 'markdown') {
                    blocks = blocks.map(block => Object.assign({}, block, { text: NS.common.stripHtml(block.text) }));
                }
            }

            if (!blocks.length) {
                this.notify('The draft came back empty. Your transcript is kept.', 'warn');
                return;
            }

            if (title && !NS.bridge.getTitle()) {
                NS.bridge.setTitle(title);
            }

            adapter.insertBlocks(blocks);
            this.draft = null;
            this._saveDraft();
            this.mode = 'dictate';
            this.lastInserted = '';
            this.notify('Draft added to the editor. Keep talking to dictate, or say “editor, …” to edit.', 'success');
            this.setStatus(this._idleStatus());
            this.ui && this.ui.render();
        }

        discardDraft () {
            this.draft = null;
            this._saveDraft();

            if (this.mode === 'draft') {
                this.mode = 'dictate';
            }

            this.notify('Draft discarded.', 'info');
            this.ui && this.ui.render();
        }
    }

    NS.Session = Session;
})(window);
