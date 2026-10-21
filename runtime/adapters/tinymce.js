/*
 * Talk It Out — adapter for Publii's WYSIWYG editor (TinyMCE 5).
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const C = NS.common;

    function create () {
        const editor = (window.tinymce && (window.tinymce.get('post-editor') || window.tinymce.activeEditor)) || null;

        if (!editor || !editor.initialized || !editor.getBody()) {
            return null;
        }

        const win = () => editor.getWin();
        const doc = () => editor.getDoc();
        const body = () => editor.getBody();

        function changed () {
            editor.nodeChanged();
            editor.fire('change');
            NS.bridge.reportChange();
        }

        function transact (fn) {
            let result;
            editor.undoManager.transact(() => { result = fn(); });
            changed();
            return result;
        }

        function topBlock (node) {
            let b = body();
            node = node || editor.selection.getNode();

            while (node && node.parentNode && node.parentNode !== b) {
                node = node.parentNode;
            }

            return node && node.parentNode === b ? node : null;
        }

        function currentBlock () {
            return topBlock() || body().lastElementChild;
        }

        function blocks () {
            return Array.from(body().children).filter(el => !el.hasAttribute('data-mce-bogus'));
        }

        function ensureFocus () {
            if (!editor.hasFocus()) {
                editor.focus();
            }
        }

        function isEmpty () {
            return body().textContent.trim() === '' && !body().querySelector('img,iframe,video,figure,hr,table');
        }

        const api = {
            kind: 'tinymce',
            contentFormat: 'html',
            label: 'WYSIWYG editor',

            isAlive () {
                return !!(editor.getBody() && document.body.contains(editor.getContainer()));
            },

            focus: ensureFocus,

            onKeydown (handler) {
                editor.on('keydown', handler);
            },

            textBeforeCursor () {
                return C.textBeforeCaret(win(), currentBlock());
            },

            insertText (text) {
                ensureFocus();
                let insert = C.prepareInsertion(api.textBeforeCursor(), text);

                if (!insert) {
                    return '';
                }

                transact(() => doc().execCommand('insertText', false, insert));
                return insert;
            },

            deleteBackward (count) {
                ensureFocus();
                let sel = win().getSelection();
                sel.collapseToEnd();

                for (let i = 0; i < count; i++) {
                    sel.modify('extend', 'backward', 'character');
                }

                transact(() => doc().execCommand('delete'));
                return true;
            },

            selectBackward (count) {
                ensureFocus();
                let sel = win().getSelection();
                sel.collapseToEnd();

                for (let i = 0; i < count; i++) {
                    sel.modify('extend', 'backward', 'character');
                }

                return !sel.isCollapsed;
            },

            newParagraph () {
                ensureFocus();
                transact(() => editor.execCommand('mceInsertNewLine'));
            },

            newLine () {
                ensureFocus();
                transact(() => editor.execCommand('InsertLineBreak'));
            },

            undo () {
                editor.undoManager.undo();
                changed();
            },

            redo () {
                editor.undoManager.redo();
                changed();
            },

            deleteUnit (unit) {
                ensureFocus();

                if (unit === 'paragraph') {
                    return api.deleteBlock();
                }

                if (!C.extendBackward(win(), unit)) {
                    return false;
                }

                transact(() => doc().execCommand('delete'));
                return true;
            },

            deleteSelection () {
                if (editor.selection.isCollapsed()) {
                    return false;
                }

                transact(() => doc().execCommand('delete'));
                return true;
            },

            deleteBlock () {
                let block = currentBlock();

                if (!block) {
                    return false;
                }

                transact(() => {
                    let previous = block.previousElementSibling;
                    block.remove();

                    if (!blocks().length) {
                        editor.setContent('<p></p>');
                    } else if (previous) {
                        editor.selection.select(previous, true);
                        editor.selection.collapse(false);
                    }
                });

                return true;
            },

            selectBlock () {
                let block = currentBlock();

                if (block) {
                    editor.selection.select(block, true);
                }

                return !!block;
            },

            selectUnit (unit) {
                ensureFocus();
                return C.extendBackward(win(), unit);
            },

            selectAll () {
                editor.selection.select(body(), true);
                return true;
            },

            findRange (phrase) {
                let block = topBlock();
                return (block && C.findTextRange(block, phrase)) || C.findTextRange(body(), phrase);
            },

            selectPhrase (phrase) {
                let range = api.findRange(phrase);

                if (!range) {
                    return false;
                }

                ensureFocus();
                editor.selection.setRng(range);
                return true;
            },

            replaceText (find, replacement) {
                if (!api.selectPhrase(find)) {
                    return false;
                }

                transact(() => doc().execCommand('insertText', false, replacement));
                return true;
            },

            deletePhrase (phrase) {
                if (!api.selectPhrase(phrase)) {
                    return false;
                }

                transact(() => doc().execCommand('delete'));
                return true;
            },

            hasSelection () {
                return !editor.selection.isCollapsed();
            },

            getSelectionText () {
                return editor.selection.isCollapsed() ? '' : editor.selection.getContent({ format: 'text' });
            },

            format (style) {
                let command = { bold: 'Bold', unbold: 'Bold', italic: 'Italic', underline: 'Underline' }[style];

                if (!command) {
                    return false;
                }

                transact(() => editor.execCommand(command));
                return true;
            },

            setBlockType ({ type, level }) {
                ensureFocus();

                transact(() => {
                    if (type === 'heading') {
                        editor.execCommand('FormatBlock', false, 'h' + (level || 2));
                    } else if (type === 'paragraph') {
                        editor.execCommand('FormatBlock', false, 'p');
                    } else if (type === 'quote') {
                        editor.execCommand('mceBlockQuote');
                    } else if (type === 'bullet_list') {
                        editor.execCommand('InsertUnorderedList');
                    } else if (type === 'numbered_list') {
                        editor.execCommand('InsertOrderedList');
                    }
                });

                return true;
            },

            insertHeading (level, text) {
                let block = currentBlock();
                let heading = C.blockToHtml({ type: 'heading', level, text: C.escapeHtml(text) });

                transact(() => {
                    let tpl = doc().createElement('template');
                    tpl.innerHTML = heading + '<p><br data-mce-bogus="1"></p>';
                    let paragraph = tpl.content.lastChild;

                    if (block && block.textContent.trim() === '' && !block.querySelector('img')) {
                        block.replaceWith(tpl.content);
                    } else if (block) {
                        block.after(tpl.content);
                    } else {
                        body().appendChild(tpl.content);
                    }

                    editor.selection.setCursorLocation(paragraph, 0);
                });
            },

            navigate (to) {
                ensureFocus();
                let block = currentBlock();
                let target = null;

                if (to === 'start') {
                    target = blocks()[0];
                } else if (to === 'end') {
                    target = blocks()[blocks().length - 1];
                } else if (to === 'next') {
                    target = block && block.nextElementSibling;
                } else if (to === 'previous') {
                    target = block && block.previousElementSibling;
                }

                if (!target) {
                    return false;
                }

                editor.selection.select(target, true);
                // Caret goes to the start of the target block, except for "end"
                editor.selection.collapse(to !== 'end');
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return true;
            },

            currentBlockText () {
                let block = currentBlock();
                return block ? block.textContent : '';
            },

            getBlocks () {
                return blocks().map((el, index) => Object.assign({ index }, C.describeElement(el)));
            },

            getCurrentBlockIndex () {
                let block = topBlock();
                return block ? blocks().indexOf(block) : -1;
            },

            isEmpty,

            // ops: [{ action: 'replace'|'insert_after'|'delete', index, blocks }], applied high index first
            applyOps (ops) {
                let list = blocks();

                transact(() => {
                    ops.slice().sort((a, b) => b.index - a.index).forEach(op => {
                        let el = list[op.index];
                        let html = (op.blocks || []).map(C.blockToHtml).join('');

                        if (op.action === 'delete' && el) {
                            el.remove();
                        } else if (op.action === 'replace' && el) {
                            let tpl = doc().createElement('template');
                            tpl.innerHTML = html;
                            el.replaceWith(tpl.content);
                        } else if (op.action === 'insert_after') {
                            let tpl = doc().createElement('template');
                            tpl.innerHTML = html;

                            if (op.index < 0 || !list.length) {
                                body().prepend(tpl.content);
                            } else if (list[op.index]) {
                                list[op.index].after(tpl.content);
                            }
                        }
                    });

                    if (!blocks().length) {
                        editor.setContent('<p></p>');
                    }
                });
            },

            insertBlocks (newBlocks) {
                let html = newBlocks.map(C.blockToHtml).join('');

                if (isEmpty()) {
                    editor.setContent(html);
                    editor.undoManager.add();
                    changed();
                } else {
                    let block = currentBlock();

                    transact(() => {
                        let tpl = doc().createElement('template');
                        tpl.innerHTML = html;

                        if (block) {
                            block.after(tpl.content);
                        } else {
                            body().appendChild(tpl.content);
                        }
                    });
                }

                // Caret at the end of the last block, so "this paragraph" has a target
                let last = blocks()[blocks().length - 1];

                if (last) {
                    editor.selection.select(last, true);
                    editor.selection.collapse(false);
                }
            }
        };

        return api;
    }

    NS.adapters = NS.adapters || {};
    NS.adapters.tinymce = { create };
})(window);
