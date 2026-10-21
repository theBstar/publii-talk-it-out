/*
 * Talk It Out — helpers shared by the editor adapters.
 *
 * Block model used between the voice engine, Claude and the adapters:
 *   { type: 'paragraph' | 'heading' | 'bullet_list' | 'numbered_list' | 'quote',
 *     level: 2-4 (headings only), text: inline content, items: [inline content] }
 * Inline content is limited HTML (strong, em, a, code, br) for the WYSIWYG and
 * Block editors, and Markdown for the Markdown editor.
 */
(function (root) {
    'use strict';

    const INLINE_TAGS = new Set(['STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE', 'A', 'BR', 'SUB', 'SUP', 'MARK']);

    function escapeHtml (text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function stripHtml (html) {
        let tpl = document.createElement('template');
        tpl.innerHTML = String(html || '');
        return (tpl.content.textContent || '').replace(/ /g, ' ');
    }

    // Model output and transcripts go into the editor, so only a small set of
    // inline tags survives. Links keep http(s)/mailto hrefs only.
    function sanitizeInline (html) {
        let tpl = document.createElement('template');
        tpl.innerHTML = String(html || '');

        function clean (node) {
            let out = '';

            node.childNodes.forEach(child => {
                if (child.nodeType === Node.TEXT_NODE) {
                    out += escapeHtml(child.textContent);
                    return;
                }

                if (child.nodeType !== Node.ELEMENT_NODE) {
                    return;
                }

                let tag = child.tagName;
                let inner = clean(child);

                if (!INLINE_TAGS.has(tag)) {
                    out += inner;
                    return;
                }

                if (tag === 'BR') {
                    out += '<br>';
                    return;
                }

                if (tag === 'A') {
                    let href = child.getAttribute('href') || '';

                    if (/^(https?:|mailto:)/i.test(href)) {
                        out += '<a href="' + escapeHtml(href) + '">' + inner + '</a>';
                    } else {
                        out += inner;
                    }

                    return;
                }

                let name = tag.toLowerCase();
                out += '<' + name + '>' + inner + '</' + name + '>';
            });

            return out;
        }

        return clean(tpl.content);
    }

    function normaliseBlock (block) {
        let type = ['paragraph', 'heading', 'bullet_list', 'numbered_list', 'quote'].indexOf(block && block.type) > -1 ? block.type : 'paragraph';
        let level = Math.min(Math.max(parseInt(block && block.level, 10) || 2, 1), 6);

        return {
            type,
            level: type === 'heading' ? level : 0,
            text: String((block && block.text) || ''),
            items: Array.isArray(block && block.items) ? block.items.map(String) : []
        };
    }

    function blockToHtml (rawBlock) {
        let block = normaliseBlock(rawBlock);

        switch (block.type) {
            case 'heading':
                return '<h' + block.level + '>' + sanitizeInline(block.text) + '</h' + block.level + '>';
            case 'bullet_list':
            case 'numbered_list': {
                let tag = block.type === 'bullet_list' ? 'ul' : 'ol';
                let items = block.items.length ? block.items : [block.text];
                return '<' + tag + '>' + items.map(item => '<li>' + sanitizeInline(item) + '</li>').join('') + '</' + tag + '>';
            }
            case 'quote':
                return '<blockquote><p>' + sanitizeInline(block.text) + '</p></blockquote>';
            default:
                return '<p>' + sanitizeInline(block.text) + '</p>';
        }
    }

    // Safety net for the Markdown editor in case inline HTML slips through
    function inlineHtmlToMarkdown (text) {
        if (!/<[a-z][^>]*>/i.test(text)) {
            return text;
        }

        let tpl = document.createElement('template');
        tpl.innerHTML = sanitizeInline(text);

        function walk (node) {
            let out = '';

            node.childNodes.forEach(child => {
                if (child.nodeType === Node.TEXT_NODE) {
                    out += child.textContent;
                    return;
                }

                let inner = walk(child);

                switch (child.tagName) {
                    case 'STRONG': case 'B': out += '**' + inner + '**'; break;
                    case 'EM': case 'I': out += '_' + inner + '_'; break;
                    case 'CODE': out += '`' + inner + '`'; break;
                    case 'A': out += '[' + inner + '](' + child.getAttribute('href') + ')'; break;
                    case 'BR': out += '  \n'; break;
                    default: out += inner;
                }
            });

            return out;
        }

        return walk(tpl.content);
    }

    function blockToMarkdown (rawBlock) {
        let block = normaliseBlock(rawBlock);
        block.text = inlineHtmlToMarkdown(block.text);
        block.items = block.items.map(inlineHtmlToMarkdown);
        let oneLine = text => String(text).replace(/\s*\n\s*/g, ' ').trim();

        switch (block.type) {
            case 'heading':
                return '#'.repeat(block.level) + ' ' + oneLine(block.text);
            case 'bullet_list':
                return (block.items.length ? block.items : [block.text]).map(item => '- ' + oneLine(item)).join('\n');
            case 'numbered_list':
                return (block.items.length ? block.items : [block.text]).map((item, i) => (i + 1) + '. ' + oneLine(item)).join('\n');
            case 'quote':
                return '> ' + oneLine(block.text);
            default:
                return block.text.trim();
        }
    }

    // Describe an HTML element for the model: kind + content
    function describeElement (el) {
        let tag = el.tagName;

        if (/^H[1-6]$/.test(tag)) {
            return { kind: 'heading ' + tag[1], content: el.innerHTML };
        }

        if (tag === 'P') {
            return { kind: 'paragraph', content: el.innerHTML };
        }

        if (tag === 'UL' || tag === 'OL') {
            return { kind: tag === 'UL' ? 'bullet list' : 'numbered list', content: el.innerHTML };
        }

        if (tag === 'BLOCKQUOTE') {
            return { kind: 'quote', content: el.innerHTML };
        }

        let label = el.querySelector('img') ? 'image' : (tag === 'PRE' ? 'code' : (tag === 'TABLE' ? 'table' : tag.toLowerCase()));
        return { kind: 'other: ' + label, content: null };
    }

    /* ---------------------------------------------------------------------
     * Text insertion rules: spacing and sentence capitalisation
     * ------------------------------------------------------------------- */

    function prepareInsertion (textBefore, text) {
        let insert = String(text).trim();

        if (!insert) {
            return '';
        }

        let before = String(textBefore || '').replace(/ /g, ' ');
        let trimmedBefore = before.replace(/\s+$/, '');
        let atSentenceStart = trimmedBefore === '' || /[.!?:]["')\]]?$/.test(trimmedBefore);
        let startsWithPunctuation = /^[.,!?;:)\]'"%]/.test(insert);

        if (atSentenceStart) {
            insert = insert.charAt(0).toUpperCase() + insert.slice(1);
        } else if (/^[A-Z][a-z]/.test(insert) && !/^I\b/.test(insert) && /[a-z,;]$/.test(trimmedBefore)) {
            // Whisper capitalises every utterance; mid-sentence continuations shouldn't be
            insert = insert.charAt(0).toLowerCase() + insert.slice(1);
        }

        if (before !== '' && !/\s$/.test(before) && !startsWithPunctuation) {
            insert = ' ' + insert;
        }

        return insert;
    }

    /* ---------------------------------------------------------------------
     * Text search across text nodes
     * ------------------------------------------------------------------- */

    function textNodesIn (rootEl) {
        let walker = rootEl.ownerDocument.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
        let nodes = [];
        let node;

        while ((node = walker.nextNode())) {
            nodes.push(node);
        }

        return nodes;
    }

    function findTextRange (rootEl, phrase) {
        if (!rootEl || !phrase) {
            return null;
        }

        let nodes = textNodesIn(rootEl);
        let full = '';
        let map = [];

        nodes.forEach(node => {
            map.push({ node, start: full.length });
            full += node.textContent;
        });

        let haystack = full.replace(/ /g, ' ').toLowerCase();
        let needle = String(phrase).replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!?]+$/, '');
        let index = haystack.indexOf(needle);

        if (index === -1 || !needle) {
            return null;
        }

        function locate (offset, preferNext) {
            for (let i = 0; i < map.length; i++) {
                let len = map[i].node.textContent.length;
                let end = map[i].start + len;

                if (offset < end || (offset === end && !preferNext) || i === map.length - 1) {
                    return { node: map[i].node, offset: Math.min(offset - map[i].start, len) };
                }
            }

            return null;
        }

        let start = locate(index, true);
        let end = locate(index + needle.length, false);

        if (!start || !end) {
            return null;
        }

        let range = rootEl.ownerDocument.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return range;
    }

    /* ---------------------------------------------------------------------
     * Selection-based operations for contenteditable surfaces
     * (TinyMCE's iframe body, Block editor blocks)
     * ------------------------------------------------------------------- */

    function textBeforeCaret (win, containerEl) {
        let sel = win.getSelection();

        if (!sel.rangeCount || !containerEl) {
            return '';
        }

        let range = sel.getRangeAt(0).cloneRange();

        if (!containerEl.contains(range.startContainer)) {
            return '';
        }

        range.collapse(true);
        range.setStart(containerEl, 0);
        return range.toString();
    }

    function extendBackward (win, granularity, times = 1) {
        let sel = win.getSelection();

        if (!sel.rangeCount) {
            return false;
        }

        sel.collapseToEnd();

        // A caret just before the closing period would leave a stray "." behind
        if (granularity === 'sentence') {
            sel.modify('move', 'forward', 'sentenceboundary');
        }

        for (let i = 0; i < times; i++) {
            sel.modify('extend', 'backward', granularity);
        }

        // "delete last word" right after "word." first selects only the period
        if (granularity === 'word' && /^[\s.,!?;:]*$/.test(sel.toString())) {
            sel.modify('extend', 'backward', 'word');
        }

        return !sel.isCollapsed;
    }

    function selectRange (win, range) {
        let sel = win.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function placeCaret (win, el, atEnd = true) {
        let range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        range.collapse(!atEnd);
        selectRange(win, range);
    }

    root.TalkItOutNS = root.TalkItOutNS || {};
    root.TalkItOutNS.common = {
        escapeHtml,
        stripHtml,
        sanitizeInline,
        normaliseBlock,
        blockToHtml,
        blockToMarkdown,
        describeElement,
        prepareInsertion,
        findTextRange,
        textBeforeCaret,
        extendBackward,
        selectRange,
        placeCaret
    };
})(window);
