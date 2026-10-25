/*
 * Talk It Out — adapter for Publii's Block editor.
 *
 * Text goes into the focused block's contenteditable through execCommand, so
 * the blocks see normal input. Structural changes (convert, insert, AI edits)
 * go through the editor's `content` array with fresh block ids, which makes
 * Vue remount those blocks with the new content. Those changes can't be undone
 * natively, so the adapter keeps its own snapshots for "undo".
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const C = NS.common;
    const TEXT_TYPES = new Set(['publii-paragraph', 'publii-header', 'publii-list', 'publii-quote']);

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function create () {
        const host = document.querySelector('#publii-block-editor .editor');
        const vm = host && host.__vue__;

        if (!vm || !Array.isArray(vm.content) || typeof vm.addNewBlock !== 'function') {
            return null;
        }

        let lastBlockId = null;
        let lastRange = null;
        let snapshots = [];
        let lastActionStructural = false;

        function component (id) {
            let ref = vm.$refs['block-' + id];
            return ref && ref[0] ? ref[0] : null;
        }

        function editable (id) {
            let comp = component(id);

            if (!comp) {
                return null;
            }

            let refName = typeof comp.getFocusableElement === 'function' ? comp.getFocusableElement() : 'block';
            let el = comp.$refs[refName] || comp.$refs.block;
            return el && el.isContentEditable ? el : null;
        }

        function blockIdFromNode (node) {
            let ids = new Set(vm.content.map(block => block.id));

            while (node && node !== host) {
                if (node.id && ids.has(node.id)) {
                    return node.id;
                }

                node = node.parentNode;
            }

            return null;
        }

        function trackSelection () {
            let sel = document.getSelection();

            if (!sel.rangeCount || !host.contains(sel.anchorNode)) {
                return;
            }

            let id = blockIdFromNode(sel.anchorNode);

            if (id) {
                lastBlockId = id;
                lastRange = sel.getRangeAt(0).cloneRange();
            }
        }

        document.addEventListener('selectionchange', trackSelection);

        function currentId () {
            let ids = vm.content.map(block => block.id);

            if (lastBlockId && ids.indexOf(lastBlockId) > -1) {
                return lastBlockId;
            }

            if (vm.internal && ids.indexOf(vm.internal.currentBlockID) > -1) {
                return vm.internal.currentBlockID;
            }

            return ids[ids.length - 1] || null;
        }

        function currentIndex () {
            return vm.content.findIndex(block => block.id === currentId());
        }

        // Focus the block we were last in and restore the caret
        function focusCurrent () {
            let id = currentId();
            let el = id && editable(id);

            if (!el) {
                return null;
            }

            if (document.activeElement !== el) {
                el.focus();

                if (lastRange && el.contains(lastRange.startContainer)) {
                    C.selectRange(window, lastRange);
                } else {
                    C.placeCaret(window, el, true);
                }
            }

            return el;
        }

        // Pull the latest DOM content of every block into vm.content
        function syncAll () {
            vm.content.forEach(block => {
                let comp = component(block.id);

                if (comp && typeof comp.save === 'function') {
                    try { comp.save(); } catch (e) {}
                }
            });
        }

        function snapshot () {
            syncAll();
            snapshots.push(JSON.parse(JSON.stringify(vm.content)));

            if (snapshots.length > 30) {
                snapshots.shift();
            }

            lastActionStructural = true;
        }

        function setContent (blocks) {
            vm.content.splice(0, vm.content.length, ...blocks);
            NS.bridge.reportChange();
        }

        function toEditorBlock (rawBlock) {
            let block = C.normaliseBlock(rawBlock);
            let id = crypto.randomUUID();

            switch (block.type) {
                case 'heading':
                    return { id, type: 'publii-header', content: C.sanitizeInline(block.text), config: { headingLevel: Math.min(Math.max(block.level, 1), 6) } };
                case 'bullet_list':
                case 'numbered_list': {
                    let items = block.items.length ? block.items : [block.text];
                    return {
                        id,
                        type: 'publii-list',
                        content: items.map(item => '<li>' + C.sanitizeInline(item) + '</li>').join(''),
                        config: { listType: block.type === 'bullet_list' ? 'ul' : 'ol' }
                    };
                }
                case 'quote':
                    return { id, type: 'publii-quote', content: { text: C.sanitizeInline(block.text), author: '' }, config: {} };
                default:
                    return { id, type: 'publii-paragraph', content: C.sanitizeInline(block.text), config: {} };
            }
        }

        function blockHtml (block) {
            let el = editable(block.id);

            if (el) {
                return el.innerHTML;
            }

            return block.type === 'publii-quote' ? (block.content && block.content.text) || '' : String(block.content || '');
        }

        function describe (block) {
            switch (block.type) {
                case 'publii-paragraph':
                    return { kind: 'paragraph', content: blockHtml(block) };
                case 'publii-header':
                    return { kind: 'heading ' + ((block.config && block.config.headingLevel) || 2), content: blockHtml(block) };
                case 'publii-list':
                    return { kind: (block.config && block.config.listType) === 'ol' ? 'numbered list' : 'bullet list', content: blockHtml(block) };
                case 'publii-quote':
                    return { kind: 'quote', content: blockHtml(block) };
                default:
                    return { kind: 'other: ' + block.type.replace('publii-', ''), content: null };
            }
        }

        function collapseSelection () {
            let sel = document.getSelection();

            if (sel.rangeCount && !sel.isCollapsed) {
                sel.collapseToEnd();
            }
        }

        function isEmpty () {
            return vm.content.every(block => block.type === 'publii-paragraph' && C.stripHtml(blockHtml(block)).trim() === '');
        }

        function textOp (fn) {
            let el = focusCurrent();

            if (!el) {
                return false;
            }

            lastActionStructural = false;
            let result = fn(el);
            NS.bridge.reportChange();
            return result;
        }

        const api = {
            kind: 'blockeditor',
            contentFormat: 'html',
            label: 'Block editor',

            isAlive () {
                return document.body.contains(host);
            },

            focus () {
                focusCurrent();
            },

            onKeydown () {
                // Blocks live in the main document, so the global key handler covers them
            },

            destroy () {
                document.removeEventListener('selectionchange', trackSelection);
            },

            textBeforeCursor () {
                let el = editable(currentId());
                return el ? C.textBeforeCaret(window, el) : '';
            },

            insertText (text) {
                return textOp(el => {
                    let insert = C.prepareInsertion(C.textBeforeCaret(window, el), text);

                    if (insert) {
                        document.execCommand('insertText', false, insert);
                        trackSelection();
                    }

                    return insert;
                });
            },

            deleteBackward (count) {
                return textOp(() => {
                    let sel = document.getSelection();
                    sel.collapseToEnd();

                    for (let i = 0; i < count; i++) {
                        sel.modify('extend', 'backward', 'character');
                    }

                    document.execCommand('delete');
                    return true;
                });
            },

            selectBackward (count) {
                return !!focusCurrent() && (() => {
                    let sel = document.getSelection();
                    sel.collapseToEnd();

                    for (let i = 0; i < count; i++) {
                        sel.modify('extend', 'backward', 'character');
                    }

                    return !sel.isCollapsed;
                })();
            },

            async newParagraph () {
                let id = currentId();
                lastActionStructural = false;
                vm.addNewBlock('publii-paragraph', id);
                await sleep(90);
                let index = vm.content.findIndex(block => block.id === id);
                lastBlockId = vm.content[index + 1] ? vm.content[index + 1].id : lastBlockId;
                lastRange = null;
                NS.bridge.reportChange();
            },

            newLine () {
                return textOp(() => document.execCommand('insertLineBreak'));
            },

            undo () {
                if (lastActionStructural && snapshots.length) {
                    let previous = snapshots.pop();
                    setContent(previous.map(block => Object.assign({}, block, { id: crypto.randomUUID() })));
                    lastActionStructural = snapshots.length > 0;
                    return;
                }

                focusCurrent();
                document.execCommand('undo');
                collapseSelection();
            },

            redo () {
                focusCurrent();
                document.execCommand('redo');
                collapseSelection();
            },

            deleteUnit (unit) {
                if (unit === 'paragraph') {
                    return api.deleteBlock();
                }

                return textOp(() => {
                    if (!C.extendBackward(window, unit)) {
                        return false;
                    }

                    document.execCommand('delete');
                    return true;
                });
            },

            deleteSelection () {
                return textOp(() => {
                    if (document.getSelection().isCollapsed) {
                        return false;
                    }

                    document.execCommand('delete');
                    return true;
                });
            },

            deleteBlock () {
                let id = currentId();

                if (!id) {
                    return false;
                }

                snapshot();
                vm.deleteBlock(id);
                lastBlockId = null;
                NS.bridge.reportChange();
                return true;
            },

            selectBlock () {
                let el = focusCurrent();

                if (!el) {
                    return false;
                }

                let range = document.createRange();
                range.selectNodeContents(el);
                C.selectRange(window, range);
                return true;
            },

            selectUnit (unit) {
                return !!focusCurrent() && C.extendBackward(window, unit);
            },

            selectAll () {
                return api.selectBlock();
            },

            findRange (phrase) {
                let order = [currentId()].concat(vm.content.map(block => block.id));

                for (const id of order) {
                    let el = id && editable(id);
                    let range = el && C.findTextRange(el, phrase);

                    if (range) {
                        return { id, el, range };
                    }
                }

                return null;
            },

            selectPhrase (phrase) {
                let found = api.findRange(phrase);

                if (!found) {
                    return false;
                }

                found.el.focus();
                C.selectRange(window, found.range);
                lastBlockId = found.id;
                lastRange = found.range.cloneRange();
                return true;
            },

            replaceText (find, replacement) {
                if (!api.selectPhrase(find)) {
                    return false;
                }

                lastActionStructural = false;
                document.execCommand('insertText', false, replacement);
                NS.bridge.reportChange();
                return true;
            },

            deletePhrase (phrase) {
                if (!api.selectPhrase(phrase)) {
                    return false;
                }

                lastActionStructural = false;
                document.execCommand('delete');
                NS.bridge.reportChange();
                return true;
            },

            hasSelection () {
                let sel = document.getSelection();
                return !sel.isCollapsed && host.contains(sel.anchorNode);
            },

            getSelectionText () {
                return api.hasSelection() ? document.getSelection().toString() : '';
            },

            format (style) {
                let command = { bold: 'bold', unbold: 'bold', italic: 'italic', underline: 'underline' }[style];
                return !!command && textOp(() => document.execCommand(command));
            },

            setBlockType ({ type, level }) {
                let index = currentIndex();

                if (index < 0) {
                    return false;
                }

                let current = vm.content[index];

                if (!TEXT_TYPES.has(current.type)) {
                    return false;
                }

                let html = blockHtml(current);
                let items = [];

                if (current.type === 'publii-list') {
                    let tpl = document.createElement('template');
                    tpl.innerHTML = html;
                    items = Array.from(tpl.content.querySelectorAll('li')).map(li => li.innerHTML);
                    html = items.join('<br>');
                }

                snapshot();
                let replacement = toEditorBlock({ type, level, text: html, items: items.length ? items : [html] });
                vm.content.splice(index, 1, replacement);
                lastBlockId = replacement.id;
                lastRange = null;
                NS.bridge.reportChange();
                return true;
            },

            async insertHeading (level, text) {
                let index = currentIndex();
                let current = vm.content[index];
                let heading = toEditorBlock({ type: 'heading', level, text: C.escapeHtml(text) });
                let paragraph = toEditorBlock({ type: 'paragraph', text: '' });

                snapshot();

                if (current && current.type === 'publii-paragraph' && C.stripHtml(blockHtml(current)).trim() === '') {
                    vm.content.splice(index, 1, heading, paragraph);
                } else {
                    vm.content.splice(index + 1, 0, heading, paragraph);
                }

                lastBlockId = paragraph.id;
                lastRange = null;
                await sleep(60);
                focusCurrent();
                NS.bridge.reportChange();
            },

            navigate (to) {
                let ids = vm.content.map(block => block.id);
                let index = currentIndex();
                let target = { start: 0, end: ids.length - 1, next: index + 1, previous: index - 1 }[to];

                if (target === undefined || target < 0 || target >= ids.length) {
                    return false;
                }

                let el = editable(ids[target]);

                if (!el) {
                    return false;
                }

                el.focus();
                C.placeCaret(window, el, to === 'end');
                lastBlockId = ids[target];
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return true;
            },

            currentBlockText () {
                let el = editable(currentId());
                return el ? el.textContent : '';
            },

            getBlocks () {
                return vm.content.map((block, index) => Object.assign({ index }, describe(block)));
            },

            getCurrentBlockIndex () {
                return lastBlockId ? currentIndex() : -1;
            },

            isEmpty,

            applyOps (ops) {
                snapshot();
                let next = vm.content.slice();

                ops.slice().sort((a, b) => b.index - a.index).forEach(op => {
                    let replacement = (op.blocks || []).map(toEditorBlock);

                    if (op.action === 'delete' && next[op.index]) {
                        next.splice(op.index, 1);
                    } else if (op.action === 'replace' && next[op.index]) {
                        next.splice(op.index, 1, ...replacement);
                    } else if (op.action === 'insert_after') {
                        next.splice(Math.max(op.index + 1, 0), 0, ...replacement);
                    }
                });

                if (!next.length) {
                    next.push(toEditorBlock({ type: 'paragraph', text: '' }));
                }

                setContent(next);
                lastBlockId = null;
            },

            insertBlocks (newBlocks) {
                snapshot();
                let converted = newBlocks.map(toEditorBlock);

                if (isEmpty()) {
                    setContent(converted);
                } else {
                    let index = currentIndex();
                    let next = vm.content.slice();
                    next.splice(index < 0 ? next.length : index + 1, 0, ...converted);
                    setContent(next);
                }

                lastBlockId = converted[converted.length - 1].id;
                lastRange = null;
            }
        };

        return api;
    }

    NS.adapters = NS.adapters || {};
    NS.adapters.blockeditor = { create };
})(window);
