// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, isLikelyNoise, stripWakeWord } = require('../runtime/commands.js');

const cmd = (text, opts) => parse(text, Object.assign({ mode: 'command', aiEnabled: true }, opts));
const dictate = (text, opts) => parse(text, Object.assign({ mode: 'dictate', aiEnabled: true }, opts));
const draft = (text, opts) => parse(text, Object.assign({ mode: 'draft', aiEnabled: true }, opts));

test('dictation passes ordinary speech through as text', () => {
    assert.deepEqual(dictate('I went to the market this morning.'), { kind: 'text', text: 'I went to the market this morning.' });
});

test('dictation recognises whole-utterance safe commands', () => {
    assert.equal(dictate('New paragraph.').name, 'newParagraph');
    assert.equal(dictate('Scratch that.').name, 'deleteLast');
    assert.equal(dictate('Undo.').name, 'undo');
    assert.equal(dictate('Stop listening.').name, 'stop');
});

test('dictation does not treat editing phrases as commands without the wake word', () => {
    assert.equal(dictate('Replace the old engine with a new one.').kind, 'text');
    assert.equal(dictate('Delete everything you know about marketing.').kind, 'text');
    assert.equal(dictate('Make this a heading').kind, 'text');
});

test('wake word turns dictation into a command', () => {
    let result = dictate('Editor, make this a heading.');
    assert.equal(result.kind, 'command');
    assert.equal(result.name, 'setBlockType');
    assert.deepEqual(result.args, { type: 'heading', level: 2 });
});

test('misheard wake word still works and unknown instructions go to AI', () => {
    let result = dictate('Cloud, tighten up this paragraph and make it friendlier.');
    assert.equal(result.kind, 'ai');
    assert.equal(result.instruction, 'tighten up this paragraph and make it friendlier.');
});

test('without AI unknown commands are reported as unknown', () => {
    assert.equal(cmd('rewrite the intro', { aiEnabled: false }).name, 'unknown');
});

test('replace keeps the original casing', () => {
    let result = cmd('Replace Publi with Publii.');
    assert.equal(result.name, 'replace');
    assert.deepEqual(result.args, { find: 'Publi', replacement: 'Publii' });
});

test('"change this to ..." is an instruction, not a find/replace', () => {
    assert.equal(cmd('change this to something punchier').kind, 'ai');
    assert.equal(cmd('change this to a bullet list').name, 'setBlockType');
});

test('block conversions', () => {
    assert.deepEqual(cmd('turn this into a numbered list').args, { type: 'numbered_list', level: 0 });
    assert.deepEqual(cmd('make it a quote').args, { type: 'quote', level: 0 });
    assert.deepEqual(cmd('convert this paragraph to heading three').args, { type: 'heading', level: 3 });
    assert.deepEqual(cmd('make this a subheading').args, { type: 'heading', level: 3 });
    assert.deepEqual(cmd('make this a paragraph').args, { type: 'paragraph', level: 0 });
});

test('headings, titles and formatting', () => {
    assert.deepEqual(cmd('Heading two: Why voice matters.').args, { level: 2, text: 'Why voice matters' });
    assert.deepEqual(cmd('Set the title to Writing by voice').args, { text: 'Writing by voice' });
    assert.deepEqual(cmd('bold that').args, { style: 'bold' });
    assert.deepEqual(cmd('italicize the quick fox').args, { style: 'italic', phrase: 'the quick fox' });
});

test('navigation and deletion', () => {
    assert.deepEqual(cmd('go to the end of the post').args, { to: 'end' });
    assert.deepEqual(cmd('next paragraph').args, { to: 'next' });
    assert.equal(cmd('delete this paragraph').name, 'deleteBlock');
    assert.deepEqual(cmd('delete the last sentence').args, { unit: 'sentence' });
    assert.deepEqual(cmd('delete the word basically').args, { phrase: 'basically' });
});

test('draft mode collects text and understands draft commands', () => {
    assert.equal(draft('So today I want to talk about gardening.').kind, 'text');
    assert.equal(draft('New paragraph').name, 'newParagraph');
    assert.deepEqual(draft('Heading: getting started').args, { level: 2, text: 'getting started' });
    assert.equal(draft('Finish the draft.').name, 'finishDraft');
    assert.equal(draft("I'm done").kind, 'text');
    assert.equal(draft('Replace a with b').kind, 'text');
});

test('noise filter catches common Whisper hallucinations on short clips', () => {
    assert.equal(isLikelyNoise('Thank you.', 0.6), true);
    assert.equal(isLikelyNoise('[BLANK_AUDIO]', 1), true);
    assert.equal(isLikelyNoise('you', 0.4), true);
    assert.equal(isLikelyNoise('Thank you.', 3), false);
    assert.equal(isLikelyNoise('Thank you for reading my post.', 0.9), false);
});

test('noise filter drops video-outro hallucinations unless clearly spoken at length', () => {
    assert.equal(isLikelyNoise('Can you please subscribe to our channel?', 1.2), true);
    assert.equal(isLikelyNoise('Thank you. Please subscribe to our channel.', 2), true);
    assert.equal(isLikelyNoise('Thanks for watching!', 2.5), true);
    assert.equal(isLikelyNoise('Subscribe to my newsletter for more posts.', 2), false);
    assert.equal(isLikelyNoise('Thank you. I really enjoyed writing this.', 1), false);
    assert.equal(isLikelyNoise('Please subscribe to our channel and share it with friends who cook.', 6), false);
});

test('wake word stripping', () => {
    assert.equal(stripWakeWord('Hey Claude, save', ['claude']), 'save');
    assert.equal(stripWakeWord('Claudette is my aunt', ['claude']), null);
});

const { parseUtterance } = require('../runtime/commands.js');

test('commands spoken mid-utterance are split out and run in order', () => {
    const intents = parseUtterance('Talking to Publii finally works. New paragraph. This was spoken out loud. Editor, make this a heading.', { mode: 'dictate', aiEnabled: false });
    assert.deepEqual(intents.map(i => i.kind === 'text' ? 'text:' + i.text : i.name), [
        'text:Talking to Publii finally works.',
        'newParagraph',
        'text:This was spoken out loud.',
        'setBlockType'
    ]);
});

test('ordinary multi-sentence dictation stays one text insert', () => {
    const intents = parseUtterance('I walked to the shop. It was closed. So I went home.', { mode: 'dictate' });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].text, 'I walked to the shop. It was closed. So I went home.');
});

test('a whole utterance that is a command still works', () => {
    const intents = parseUtterance('Editor, replace the cat with the dog.', { mode: 'dictate', aiEnabled: false });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].name, 'replace');
});

test('a bare "stop" while dictating is text, "stop listening" stops', () => {
    assert.equal(parse('Stop.', { mode: 'dictate' }).kind, 'text');
    assert.equal(parse('Pause.', { mode: 'dictate' }).kind, 'text');
    assert.equal(parse('Stop listening.', { mode: 'dictate' }).name, 'stop');
    assert.equal(parse('Stop.', { mode: 'command' }).name, 'stop');
    assert.equal(parse('Editor, stop.', { mode: 'dictate' }).name, 'stop');
});

test('draft mode splits out structure commands too', () => {
    const intents = parseUtterance('I started this blog last year. Heading: what I learned. New paragraph. Mostly patience.', { mode: 'draft' });
    assert.deepEqual(intents.map(i => i.kind === 'text' ? 'text' : i.name), ['text', 'insertHeading', 'newParagraph', 'text']);
});
