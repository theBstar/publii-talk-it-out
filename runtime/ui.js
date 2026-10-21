/*
 * Talk It Out — floating panel shown in Publii's post/page editors.
 *
 * Rendered inside a shadow root so Publii's styles and ours never mix.
 * Mouse-down on the panel is cancelled so the editor keeps its caret and
 * selection while you click the panel's buttons.
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;

    const HELP = [
        ['While dictating', [
            ['new paragraph · new line', 'break the text'],
            ['scratch that · undo · redo', 'take back the last bit'],
            ['stop listening', 'turn the mic off']
        ]],
        ['Editing — say “Editor, …” or switch to Edit', [
            ['replace X with Y · delete X', 'change exact words'],
            ['select X · select paragraph', 'pick text'],
            ['bold that · italicize X', 'inline formatting'],
            ['make this a heading / list / quote', 'change the block'],
            ['heading two: Your heading', 'insert a heading'],
            ['delete last sentence · delete paragraph', 'remove text'],
            ['go to the end · next paragraph', 'move the caret'],
            ['set the title to …', 'post title'],
            ['read this back · save', '']
        ]],
        ['With Claude enabled — say “Claude, …”', [
            ['Claude, tighten this paragraph', ''],
            ['Claude, add a conclusion that sums this up', ''],
            ['Claude, fix the grammar in the intro', '']
        ]],
        ['Drafting', [
            ['start a draft · draft mode', 'talk freely, nothing is typed yet'],
            ['heading: … · new paragraph', 'add structure as you go'],
            ['finish the draft · cancel draft', 'write it into the post']
        ]]
    ];

    const MIC_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5Zm6-3.5a.9.9 0 1 0-1.8 0 4.2 4.2 0 0 1-8.4 0 .9.9 0 1 0-1.8 0 6 6 0 0 0 5.1 5.93V19H9a.9.9 0 1 0 0 1.8h6a.9.9 0 1 0 0-1.8h-2.1v-2.07A6 6 0 0 0 18 11Z"/></svg>';
    const STOP_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';

    function el (tag, attrs, children) {
        let node = document.createElement(tag);

        Object.entries(attrs || {}).forEach(([key, value]) => {
            if (key === 'text') node.textContent = value;
            else if (key === 'html') node.innerHTML = value;
            else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
            else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : value);
        });

        (children || []).forEach(child => child && node.appendChild(child));
        return node;
    }

    class Panel {
        constructor (session, baseUrl, pluginDir) {
            this.session = session;
            this.baseUrl = baseUrl;
            this.pluginDir = pluginDir;
            this.collapsed = false;
            this.helpOpen = false;
            this._build();
            session.attachUI(this);
            NS.claude.onUsage(usage => this.setUsage(usage));
            this.render();
        }

        _build () {
            this.host = el('div', { id: 'talk-it-out-root' });
            this.shadow = this.host.attachShadow({ mode: 'open' });
            this.shadow.appendChild(el('link', { rel: 'stylesheet', href: this.baseUrl + 'talk-it-out.css' }));

            this.micButton = el('button', {
                class: 'vw-mic',
                type: 'button',
                title: 'Start or stop listening (⌥⇧V)',
                onclick: () => this.session.toggle()
            });

            this.modeButtons = {};
            let modes = el('div', { class: 'vw-modes', role: 'radiogroup', 'aria-label': 'Voice mode' },
                [['dictate', 'Dictate'], ['command', 'Edit'], ['draft', 'Draft']].map(([mode, label]) => {
                    this.modeButtons[mode] = el('button', {
                        type: 'button',
                        role: 'radio',
                        'data-mode': mode,
                        text: label,
                        title: { dictate: 'Speech is typed at the cursor (⌥⇧C toggles Edit)', command: 'Speech is treated as editing commands', draft: 'Talk freely; the article is written when you finish (⌥⇧D)' }[mode],
                        onclick: () => this.session.setMode(mode)
                    });
                    return this.modeButtons[mode];
                }));

            this.helpButton = el('button', { class: 'vw-icon', type: 'button', title: 'What can I say?', text: '?', onclick: () => this.showHelp(!this.helpOpen) });
            this.settingsButton = el('button', { class: 'vw-icon', type: 'button', title: 'Talk It Out settings', html: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" transform="translate(-1 0)"/></svg>', onclick: () => this.openSettings() });
            this.expandButton = el('button', { class: 'vw-icon vw-expand', type: 'button', title: 'Expand', 'aria-label': 'Expand Talk It Out', html: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>', onclick: () => this.setCollapsed(false) });
            this.collapseButton = el('button', { class: 'vw-icon', type: 'button', title: 'Minimise', html: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 11h14v2H5z"/></svg>', onclick: () => this.setCollapsed(!this.collapsed) });

            this.meter = el('span', { class: 'vw-meter', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(() => el('i')));
            this.statusText = el('span', { class: 'vw-status-text', text: 'Not listening' });
            this.costText = el('span', { class: 'vw-cost', title: 'Estimated Claude spend this session' });

            this.heard = el('div', { class: 'vw-heard', hidden: true });
            this.toast = el('div', { class: 'vw-toast', role: 'status', 'aria-live': 'polite', hidden: true });

            this.draftCount = el('span', { class: 'vw-draft-count' });
            this.draftTitle = el('div', { class: 'vw-draft-title' });
            this.draftBody = el('div', { class: 'vw-draft-body' });
            this.finishButton = el('button', { class: 'vw-btn vw-primary', type: 'button', text: 'Finish draft', onclick: () => this.session.finishDraft() });
            this.draftPanel = el('section', { class: 'vw-draft', hidden: true, 'aria-label': 'Draft transcript' }, [
                el('div', { class: 'vw-draft-head' }, [el('strong', { text: 'Draft' }), this.draftCount]),
                this.draftTitle,
                this.draftBody,
                el('div', { class: 'vw-draft-actions' }, [
                    this.finishButton,
                    el('button', { class: 'vw-btn', type: 'button', text: 'Copy', title: 'Copy the raw transcript', onclick: () => this.copyDraft() }),
                    el('button', { class: 'vw-btn vw-quiet', type: 'button', text: 'Discard', onclick: () => this.confirmDiscard() })
                ])
            ]);

            this.progressBar = el('i');
            this.progressText = el('span');
            this.progress = el('div', { class: 'vw-progress', hidden: true }, [el('div', { class: 'vw-progress-track' }, [this.progressBar]), this.progressText]);

            this.help = el('section', { class: 'vw-help', hidden: true, 'aria-label': 'Voice commands' }, HELP.map(([title, rows]) => el('div', { class: 'vw-help-group' }, [
                el('h4', { text: title }),
                el('ul', {}, rows.map(([say, does]) => el('li', {}, [el('code', { text: say }), does ? el('span', { text: does }) : null])))
            ])));

            this.panel = el('div', { class: 'vw', 'data-state': 'idle' }, [
                el('div', { class: 'vw-bar' }, [
                    this.micButton,
                    this.expandButton,
                    el('div', { class: 'vw-main' }, [
                        el('div', { class: 'vw-top' }, [modes, el('span', { class: 'vw-grow' }), this.helpButton, this.settingsButton, this.collapseButton]),
                        el('div', { class: 'vw-status' }, [this.meter, this.statusText, this.costText])
                    ])
                ]),
                this.progress,
                this.heard,
                this.toast,
                this.draftPanel,
                this.help
            ]);

            // Keep the editor's caret where it is
            this.panel.addEventListener('mousedown', event => {
                if (!event.target.closest('.vw-draft-body')) {
                    event.preventDefault();
                }
            });

            this._enableDragging();
            this.shadow.appendChild(this.panel);
            document.body.appendChild(this.host);
            this._applyPosition();
        }

        _enableDragging () {
            let start = null;

            this.panel.addEventListener('pointerdown', event => {
                let handle = event.target.closest('.vw-top, .vw-status');

                if (!handle || event.target.closest('button')) {
                    return;
                }

                let rect = this.panel.getBoundingClientRect();
                start = { x: event.clientX, y: event.clientY, right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom };
                this.panel.setPointerCapture(event.pointerId);
                this.panel.classList.add('vw-dragging');
            });

            this.panel.addEventListener('pointermove', event => {
                if (!start) {
                    return;
                }

                let right = Math.min(Math.max(start.right - (event.clientX - start.x), 8), window.innerWidth - 80);
                let bottom = Math.min(Math.max(start.bottom - (event.clientY - start.y), 8), window.innerHeight - 60);
                this.position = { right, bottom };
                this._applyPosition();
            });

            this.panel.addEventListener('pointerup', () => {
                if (!start) {
                    return;
                }

                start = null;
                this.panel.classList.remove('vw-dragging');
                NS.settings.update({ ui: { panelPosition: this.position } });
            });
        }

        _applyPosition () {
            let position = this.position || NS.settings.load().ui.panelPosition || { right: 24, bottom: 76 };
            this.position = position;
            this.panel.style.right = position.right + 'px';
            this.panel.style.bottom = position.bottom + 'px';
        }

        render () {
            let session = this.session;
            let inEditor = !!NS.bridge.editorRoute();
            this.host.style.display = inEditor ? '' : 'none';

            this.panel.dataset.mode = session.mode;
            this.panel.dataset.collapsed = this.collapsed ? 'true' : 'false';
            this.panel.dataset.state = this.busy ? 'busy' : (session.listening ? 'listening' : 'idle');

            this.micButton.innerHTML = '<span class="vw-ring"></span>' + (session.listening ? STOP_ICON : MIC_ICON);
            this.micButton.setAttribute('aria-pressed', session.listening ? 'true' : 'false');
            this.micButton.setAttribute('aria-label', session.listening ? 'Stop listening' : 'Start listening');

            Object.entries(this.modeButtons).forEach(([mode, button]) => {
                button.setAttribute('aria-checked', mode === session.mode ? 'true' : 'false');
            });

            this._renderDraft();
            this.setUsage(NS.claude.usage());
        }

        _renderDraft () {
            let draft = this.session.draft;
            let showDraft = !this.collapsed && (this.session.mode === 'draft' || (draft && draft.segments.length > 0));
            this.draftPanel.hidden = !showDraft;

            if (!showDraft) {
                return;
            }

            let segments = draft ? draft.segments : [];
            let words = segments.filter(segment => segment.type === 'text').reduce((sum, segment) => sum + segment.text.split(/\s+/).filter(Boolean).length, 0);
            let settings = NS.settings.load();
            let aiReady = settings.ai.enabled && settings.ai.apiKey;

            this.draftCount.textContent = words + (words === 1 ? ' word' : ' words');
            this.draftTitle.textContent = draft && draft.title ? 'Title: ' + draft.title : '';
            this.draftTitle.hidden = !(draft && draft.title);
            this.finishButton.textContent = aiReady ? 'Finish with Claude' : 'Finish draft';
            this.finishButton.disabled = !words || !!this.busy;

            this.draftBody.textContent = '';

            if (!segments.length) {
                this.draftBody.appendChild(el('p', { class: 'vw-placeholder', text: 'Talk through your article. Say “heading: …” or “new paragraph” to add structure, then “finish the draft”.' }));
                return;
            }

            let paragraph = null;

            segments.forEach(segment => {
                if (segment.type === 'heading') {
                    this.draftBody.appendChild(el('h5', { text: segment.text }));
                    paragraph = null;
                } else if (segment.type === 'break') {
                    paragraph = null;
                } else {
                    if (!paragraph) {
                        paragraph = el('p');
                        this.draftBody.appendChild(paragraph);
                    }

                    paragraph.textContent += (paragraph.textContent ? ' ' : '') + segment.text;
                }
            });

            this.draftBody.scrollTop = this.draftBody.scrollHeight;
        }

        setCollapsed (collapsed) {
            this.collapsed = collapsed;

            if (collapsed) {
                this.showHelp(false);
            }

            this.render();
        }

        setStatus (text) {
            this.statusText.textContent = text;
        }

        setBusy (busy) {
            this.busy = busy;
            this.render();
        }

        setLevel (level, speaking) {
            let bars = this.meter.children;
            let shape = [0.5, 0.8, 1, 0.8, 0.5];

            for (let i = 0; i < bars.length; i++) {
                let height = 3 + Math.round(level * 13 * shape[i]);
                bars[i].style.height = height + 'px';
            }

            this.panel.classList.toggle('vw-speaking', !!speaking);
        }

        setUsage (usage) {
            if (!usage || !usage.calls) {
                this.costText.textContent = '';
                return;
            }

            this.costText.textContent = '≈ $' + (usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2));
            this.costText.title = 'Estimated Claude spend this session: ' + usage.calls + ' calls, ' +
                usage.inputTokens.toLocaleString() + ' input / ' + usage.outputTokens.toLocaleString() + ' output tokens';
        }

        setModelProgress (info) {
            if (!info || info.status === 'ready') {
                this.progress.hidden = true;
                return;
            }

            if (info.status === 'downloading') {
                this.progress.hidden = false;
                let percent = Math.round((info.progress || 0) * 100);
                this.progressBar.style.width = percent + '%';
                let mb = info.total ? ' of ' + Math.round(info.total / 1048576) + ' MB' : '';
                this.progressText.textContent = 'Downloading speech model ' + percent + '%' + mb + ' (one time)';
            }
        }

        showHeard (text, intent) {
            this.heard.hidden = this.collapsed;
            this.heard.textContent = '';

            let label = {
                text: this.session.mode === 'draft' ? 'Added' : 'Typed',
                command: 'Command',
                ai: 'To Claude'
            }[intent.kind] || 'Heard';

            this.heard.appendChild(el('span', { class: 'vw-heard-label vw-kind-' + intent.kind, text: label }));
            this.heard.appendChild(el('span', { class: 'vw-heard-text', text: text }));
        }

        notify (message, kind = 'info', actions) {
            clearTimeout(this.toastTimer);
            this.toast.hidden = false;
            this.toast.dataset.kind = kind;
            this.toast.textContent = '';
            this.toast.appendChild(el('span', { text: message }));

            (actions || []).forEach(action => {
                this.toast.appendChild(el('button', {
                    class: 'vw-link',
                    type: 'button',
                    text: action.label,
                    onclick: () => { this.toast.hidden = true; action.run(); }
                }));
            });

            let duration = kind === 'error' || (actions && actions.length) ? 12000 : 5000;
            this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, duration);

            if (this.collapsed && kind === 'error') {
                this.setCollapsed(false);
            }
        }

        showHelp (open) {
            this.helpOpen = open;
            this.help.hidden = !open;
            this.helpButton.setAttribute('aria-expanded', open ? 'true' : 'false');

            if (open && this.collapsed) {
                this.setCollapsed(false);
            }
        }

        copyDraft () {
            let text = this.session.draftTranscript();

            if (!text) {
                return;
            }

            navigator.clipboard.writeText(text).then(
                () => this.notify('Transcript copied.', 'success'),
                () => this.notify('Couldn\'t copy to the clipboard.', 'warn')
            );
        }

        confirmDiscard () {
            this.notify('Discard this draft?', 'warn', [{ label: 'Discard', run: () => this.session.discardDraft() }]);
        }

        openSettings () {
            let site = NS.bridge.siteName();
            let router = NS.bridge.router();

            if (site && router) {
                router.push('/site/' + encodeURIComponent(site) + '/tools/plugins/' + this.pluginDir);
            }
        }
    }

    NS.Panel = Panel;
})(window);
