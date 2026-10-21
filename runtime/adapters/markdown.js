/*
 * Talk It Out — adapter for Publii's Markdown editor (EasyMDE / CodeMirror 5).
 *
 * Changes use the origin "voice": CodeMirror never merges those with typing,
 * and every change made inside one cm.operation() is a single undo step.
 */
(function (root) {
    'use strict';

    const NS = root.TalkItOutNS;
    const C = NS.common;
    const ORIGIN = 'voice';
    const PREFIX = /^(#{1,6}\s+|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/;

    function create () {
        const wrapper = document.querySelector('.post-editor .CodeMirror');
        const cm = wrapper && wrapper.CodeMirror;

        if (!cm) {
            return null;
        }

        function parseBlocks () {
            let lines = cm.getValue().split('\n');
            let blocks = [];
            let start = null;
            let inFence = false;

            lines.forEach((line, i) => {
                if (/^\s*(```|~~~)/.test(line)) {
                    if (start === null) {
                        start = i;
                    }

                    inFence = !inFence;
                    return;
                }

                if (line.trim() === '' && !inFence) {
                    if (start !== null) {
                        blocks.push({ start, end: i - 1 });
                        start = null;
                    }
                } else if (start === null) {
                    start = i;
                }
            });

            if (start !== null) {
                blocks.push({ start, end: lines.length - 1 });
            }

            return blocks.map((block, index) => {
                let text = lines.slice(block.start, block.end + 1).join('\n');
                return Object.assign(block, { index, text, kind: kindOf(text) });
            });
        }

        function kindOf (text) {
            let first = text.split('\n')[0];
            let heading = first.match(/^(#{1,6})\s/);

            if (heading) return 'heading ' + heading[1].length;
            if (/^\s*[-*+]\s/.test(first)) return 'bullet list';
            if (/^\s*\d+[.)]\s/.test(first)) return 'numbered list';
            if (/^>/.test(first)) return 'quote';
            if (/^\s*(```|~~~)/.test(first)) return 'other: code';
            if (/^!\[/.test(first) || /^<(figure|img|iframe|div)/i.test(first)) return 'other: image or embed';
            return 'paragraph';
        }

        function currentBlock () {
            let line = cm.getCursor().line;
            let blocks = parseBlocks();
            let found = null;

            for (const block of blocks) {
                if (block.start <= line) {
                    found = block;
                }

                if (block.start <= line && line <= block.end) {
                    return block;
                }
            }

            return found;
        }

        function blockFrom (block) {
            return { line: block.start, ch: 0 };
        }

        function blockTo (block) {
            return { line: block.end, ch: cm.getLine(block.end).length };
        }

        function indexAt (pos) {
            return cm.indexFromPos(pos);
        }

        function posAt (index) {
            return cm.posFromIndex(index);
        }

        function op (fn) {
            let result;
            cm.operation(() => { result = fn(); });
            return result;
        }

        function textBeforeCursorInBlock () {
            let cursor = cm.getCursor();
            let block = currentBlock();

            if (!block || cursor.line > block.end) {
                return { text: '', start: cursor };
            }

            let start = blockFrom(block);
            return { text: cm.getRange(start, cursor), start };
        }

        function unitRange (unit) {
            let cursor = cm.getCursor();
            let { text, start } = textBeforeCursorInBlock();
            let startIndex = indexAt(start);

            if (unit === 'word') {
                let match = text.match(/\S+\s*$/);
                return match ? [posAt(startIndex + text.length - match[0].length), cursor] : null;
            }

            if (unit === 'sentence') {
                let trimmed = text.replace(/\s+$/, '');
                let body = trimmed.replace(/[.!?]+["')\]]*$/, '');
                let boundary = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '));
                let lineBreak = body.lastIndexOf('\n');
                let from = Math.max(boundary === -1 ? 0 : boundary + 2, lineBreak + 1);
                return text.trim() ? [posAt(startIndex + from), cursor] : null;
            }

            return null;
        }

        function findPhrase (phrase) {
            let needle = String(phrase).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').toLowerCase();

            if (!needle) {
                return null;
            }

            let haystack = cm.getValue().toLowerCase();
            let block = currentBlock();
            let index = -1;

            if (block) {
                let from = indexAt(blockFrom(block));
                let local = haystack.slice(from, indexAt(blockTo(block))).indexOf(needle);
                index = local > -1 ? from + local : -1;
            }

            if (index === -1) {
                index = haystack.indexOf(needle);
            }

            return index === -1 ? null : [posAt(index), posAt(index + needle.length)];
        }

        function isEmpty () {
            return cm.getValue().trim() === '';
        }

        function wrapSelection (marker, closing) {
            let selected = cm.getSelection();
            cm.replaceSelection(marker + selected + (closing || marker), 'around', ORIGIN);
        }

        function stripPrefixes (text) {
            return text.split('\n').map(line => line.replace(PREFIX, ''));
        }

        const api = {
            kind: 'markdown',
            contentFormat: 'markdown',
            label: 'Markdown editor',

            isAlive () {
                return document.body.contains(wrapper);
            },

            focus () {
                cm.focus();
            },

            onKeydown () {
                // CodeMirror's input lives in the main document; the global key handler covers it
            },

            textBeforeCursor () {
                let cursor = cm.getCursor();
                return cm.getLine(cursor.line).slice(0, cursor.ch);
            },

            insertText (text) {
                cm.focus();
                let insert = C.prepareInsertion(api.textBeforeCursor(), text);

                if (insert) {
                    op(() => cm.replaceSelection(insert, 'end', ORIGIN));
                }

                return insert;
            },

            deleteBackward (count) {
                let cursor = cm.getCursor();
                op(() => cm.replaceRange('', posAt(indexAt(cursor) - count), cursor, ORIGIN));
                return true;
            },

            selectBackward (count) {
                let cursor = cm.getCursor();
                cm.setSelection(posAt(indexAt(cursor) - count), cursor);
                cm.focus();
                return count > 0;
            },

            newParagraph () {
                cm.focus();
                op(() => cm.replaceSelection('\n\n', 'end', ORIGIN));
            },

            newLine () {
                cm.focus();
                op(() => cm.replaceSelection('\n', 'end', ORIGIN));
            },

            undo () {
                cm.undo();
            },

            redo () {
                cm.redo();
            },

            deleteUnit (unit) {
                if (unit === 'paragraph') {
                    return api.deleteBlock();
                }

                let range = unitRange(unit);

                if (!range) {
                    return false;
                }

                op(() => cm.replaceRange('', range[0], range[1], ORIGIN));
                return true;
            },

            deleteSelection () {
                if (!cm.somethingSelected()) {
                    return false;
                }

                op(() => cm.replaceSelection('', 'end', ORIGIN));
                return true;
            },

            deleteBlock () {
                let block = currentBlock();

                if (!block) {
                    return false;
                }

                let lastLine = cm.lastLine();
                let to = block.end < lastLine ? { line: block.end + 1, ch: cm.getLine(block.end + 1).length } : blockTo(block);
                op(() => cm.replaceRange('', blockFrom(block), to, ORIGIN));
                return true;
            },

            selectBlock () {
                let block = currentBlock();

                if (!block) {
                    return false;
                }

                cm.setSelection(blockFrom(block), blockTo(block));
                cm.focus();
                return true;
            },

            selectUnit (unit) {
                let range = unitRange(unit);

                if (!range) {
                    return false;
                }

                cm.setSelection(range[0], range[1]);
                cm.focus();
                return true;
            },

            selectAll () {
                cm.execCommand('selectAll');
                return true;
            },

            selectPhrase (phrase) {
                let range = findPhrase(phrase);

                if (!range) {
                    return false;
                }

                cm.setSelection(range[0], range[1]);
                cm.scrollIntoView(range[0], 120);
                cm.focus();
                return true;
            },

            replaceText (find, replacement) {
                let range = findPhrase(find);

                if (!range) {
                    return false;
                }

                op(() => cm.replaceRange(replacement, range[0], range[1], ORIGIN));
                return true;
            },

            deletePhrase (phrase) {
                let range = findPhrase(phrase);

                if (!range) {
                    return false;
                }

                op(() => cm.replaceRange('', range[0], range[1], ORIGIN));
                return true;
            },

            hasSelection () {
                return cm.somethingSelected();
            },

            getSelectionText () {
                return cm.getSelection();
            },

            format (style) {
                if (!cm.somethingSelected()) {
                    return false;
                }

                op(() => {
                    if (style === 'bold') wrapSelection('**');
                    else if (style === 'italic') wrapSelection('_');
                    else if (style === 'underline') wrapSelection('<u>', '</u>');
                    else if (style === 'unbold') cm.replaceSelection(cm.getSelection().replace(/^\*\*|\*\*$/g, ''), 'around', ORIGIN);
                });

                return true;
            },

            setBlockType ({ type, level }) {
                let block = currentBlock();

                if (!block || block.kind.indexOf('other') === 0) {
                    return false;
                }

                let lines = stripPrefixes(block.text);
                let output;

                if (type === 'heading') output = '#'.repeat(level || 2) + ' ' + lines.join(' ');
                else if (type === 'bullet_list') output = lines.map(line => '- ' + line).join('\n');
                else if (type === 'numbered_list') output = lines.map((line, i) => (i + 1) + '. ' + line).join('\n');
                else if (type === 'quote') output = lines.map(line => '> ' + line).join('\n');
                else output = lines.join(' ');

                op(() => cm.replaceRange(output, blockFrom(block), blockTo(block), ORIGIN));
                return true;
            },

            insertHeading (level, text) {
                let block = currentBlock();
                let heading = '#'.repeat(level || 2) + ' ' + String(text).trim();

                op(() => {
                    if (!block || isEmpty()) {
                        cm.replaceSelection(heading + '\n\n', 'end', ORIGIN);
                    } else {
                        let end = blockTo(block);
                        cm.replaceRange('\n\n' + heading + '\n\n', end, end, ORIGIN);
                        cm.setCursor(posAt(indexAt(end) + heading.length + 4));
                    }
                });
            },

            navigate (to) {
                let blocks = parseBlocks();
                let current = currentBlock();
                let index = current ? current.index : -1;
                let target = { start: blocks[0], end: blocks[blocks.length - 1], next: blocks[index + 1], previous: blocks[index - 1] }[to];

                if (!target) {
                    return false;
                }

                let pos = to === 'end' ? blockTo(target) : blockFrom(target);
                cm.setCursor(pos);
                cm.scrollIntoView(pos, 120);
                cm.focus();
                return true;
            },

            currentBlockText () {
                let block = currentBlock();
                return block ? stripPrefixes(block.text).join(' ') : '';
            },

            getBlocks () {
                return parseBlocks().map(block => ({
                    index: block.index,
                    kind: block.kind,
                    content: block.kind.indexOf('other') === 0 ? null : block.text
                }));
            },

            getCurrentBlockIndex () {
                let block = currentBlock();
                return block ? block.index : -1;
            },

            isEmpty,

            applyOps (ops) {
                let blocks = parseBlocks();

                op(() => {
                    ops.slice().sort((a, b) => b.index - a.index).forEach(change => {
                        let block = blocks[change.index];
                        let markdown = (change.blocks || []).map(C.blockToMarkdown).join('\n\n');

                        if (change.action === 'delete' && block) {
                            let to = block.end < cm.lastLine() ? { line: block.end + 1, ch: cm.getLine(block.end + 1).length } : blockTo(block);
                            cm.replaceRange('', blockFrom(block), to, ORIGIN);
                        } else if (change.action === 'replace' && block) {
                            cm.replaceRange(markdown, blockFrom(block), blockTo(block), ORIGIN);
                        } else if (change.action === 'insert_after') {
                            if (change.index < 0 || !blocks.length) {
                                cm.replaceRange(markdown + '\n\n', { line: 0, ch: 0 }, { line: 0, ch: 0 }, ORIGIN);
                            } else if (block) {
                                let end = blockTo(block);
                                cm.replaceRange('\n\n' + markdown, end, end, ORIGIN);
                            }
                        }
                    });
                });
            },

            insertBlocks (newBlocks) {
                let markdown = newBlocks.map(C.blockToMarkdown).join('\n\n');

                op(() => {
                    if (isEmpty()) {
                        cm.replaceRange(markdown + '\n', { line: 0, ch: 0 }, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }, ORIGIN);
                    } else {
                        let block = currentBlock();
                        let end = block ? blockTo(block) : { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length };
                        cm.replaceRange('\n\n' + markdown, end, end, ORIGIN);
                    }

                    cm.setCursor({ line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length });
                });
            }
        };

        return api;
    }

    NS.adapters = NS.adapters || {};
    NS.adapters.markdown = { create };
})(window);
